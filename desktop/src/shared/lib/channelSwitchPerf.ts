/**
 * Channel-switch tracing: measures click → settled-paint for channel
 * navigations, with the two relay fetches that can sit on that path
 * (message window, member roster) attributed to the switch.
 *
 * One trace is active at a time; `beginChannelSwitchTrace` (called from
 * `goChannel`) opens it and `settleChannelSwitchTrace` (called when the
 * timeline settles for that channel) closes it after the next paint. Fetch
 * traces and settles for non-active channels are ignored, so background
 * refetches never pollute a switch measurement.
 *
 * Output per switch: a `[switch-perf]` console line plus User Timing
 * marks/measures (`buzz:channel-switch:*`) so Playwright perf specs and the
 * Performance panel can read the same numbers.
 *
 * Attribution window: fetches are credited to a switch only when they finish
 * before the settled paint. A roster fetch that completes after settle is
 * deliberately not part of the felt switch latency, so such switches report
 * `members=cache` — by design, not omission.
 *
 * The settled timestamp lands one rAF after the paint, so `totalMs` includes
 * up to one display refresh interval (~17ms at 60Hz, ~8ms at 120Hz) —
 * compare before/after runs on the same display.
 */

import { invoke, isTauri } from "@tauri-apps/api/core";

export type ChannelSwitchTrace = {
  channelId: string;
  startedAt: number;
  routeCommitAt: number | null;
  windowFetch: { durationMs: number; eventCount: number } | null;
  membersFetch: { durationMs: number; memberCount: number } | null;
};

/** A switch that hasn't settled after this long is abandoned, not measured. */
const SWITCH_TRACE_TIMEOUT_MS = 30_000;

export const CHANNEL_SWITCH_START_MARK = "buzz:channel-switch:start";
export const CHANNEL_SWITCH_SETTLED_MARK = "buzz:channel-switch:settled";
export const CHANNEL_SWITCH_MEASURE = "buzz:channel-switch:click-to-settled";

let activeTrace: ChannelSwitchTrace | null = null;

/** Formats one settled trace as the `[switch-perf]` console line. */
export function summarizeChannelSwitchTrace(
  trace: ChannelSwitchTrace,
  settledAt: number,
  settleWaitTruncated = false,
): string {
  const total = Math.round(settledAt - trace.startedAt);
  const commit =
    trace.routeCommitAt === null
      ? "?"
      : `+${Math.round(trace.routeCommitAt - trace.startedAt)}ms`;
  const window =
    trace.windowFetch === null
      ? "cache"
      : `${trace.windowFetch.eventCount} events in ${Math.round(trace.windowFetch.durationMs)}ms`;
  const members =
    trace.membersFetch === null
      ? "cache"
      : `${trace.membersFetch.memberCount} members in ${Math.round(trace.membersFetch.durationMs)}ms`;
  return (
    `[switch-perf] channel=${trace.channelId.slice(0, 8)} total=${total}ms ` +
    `commit=${commit} window=${window} members=${members}` +
    (settleWaitTruncated ? " settle=truncated" : "")
  );
}

/**
 * The JSONL record persisted per settled switch. The backend folds in the
 * build's git revision and the optional BUZZ_PERF_LOG_LABEL run label, so
 * before/after sessions are attributable offline. Pure for unit testing.
 */
export function buildSwitchPerfLogRecord(
  trace: ChannelSwitchTrace,
  settledAt: number,
  settleWaitTruncated = false,
): {
  ts: string;
  channelId: string;
  totalMs: number;
  commitOffsetMs: number | null;
  windowFetch: { durationMs: number; eventCount: number } | null;
  membersFetch: { durationMs: number; memberCount: number } | null;
  settleWaitTruncated?: true;
} {
  return {
    ...(settleWaitTruncated ? { settleWaitTruncated: true as const } : {}),
    ts: new Date().toISOString(),
    channelId: trace.channelId,
    totalMs: Math.round(settledAt - trace.startedAt),
    commitOffsetMs:
      trace.routeCommitAt === null
        ? null
        : Math.round(trace.routeCommitAt - trace.startedAt),
    windowFetch: trace.windowFetch
      ? {
          durationMs: Math.round(trace.windowFetch.durationMs),
          eventCount: trace.windowFetch.eventCount,
        }
      : null,
    membersFetch: trace.membersFetch
      ? {
          durationMs: Math.round(trace.membersFetch.durationMs),
          memberCount: trace.membersFetch.memberCount,
        }
      : null,
  };
}

let hasAnnouncedLogPath = false;

/** Fire-and-forget JSONL append; diagnostics must never surface failures. */
function appendSwitchPerfLogRecord(record: Record<string, unknown>): void {
  if (!isTauri()) return;
  void invoke<string>("append_switch_perf_log", {
    recordJson: JSON.stringify(record),
  })
    .then((path) => {
      if (!hasAnnouncedLogPath) {
        hasAnnouncedLogPath = true;
        console.info(`[switch-perf] logging to ${path}`);
      }
    })
    .catch(() => {});
}

/**
 * Decides what a settle call does with the active trace. A settle for a
 * different channel must leave the trace alone — a previous channel can
 * finish loading after the next switch already began, and clobbering the
 * newer trace would silently drop exactly the slow/rapid switches this
 * instrumentation exists to capture. Only the settled channel's own trace is
 * consumed (measured, or dropped when timed out). Pure so the attribution
 * rules are unit-testable.
 */
export function resolveSettleAction(
  trace: ChannelSwitchTrace | null,
  channelId: string,
  now: number,
): { settledTrace: ChannelSwitchTrace | null; clearActive: boolean } {
  if (!trace || trace.channelId !== channelId) {
    return { settledTrace: null, clearActive: false };
  }
  if (now - trace.startedAt > SWITCH_TRACE_TIMEOUT_MS) {
    return { settledTrace: null, clearActive: true };
  }
  return { settledTrace: trace, clearActive: true };
}

/**
 * Drops the active trace for surfaces whose readiness this instrument cannot
 * observe (e.g. forum channels, whose loading is owned by ForumView's own
 * queries). Better no measurement than a systematically underreported one.
 */
export function abandonChannelSwitchTrace(channelId: string): void {
  if (activeTrace?.channelId === channelId) {
    activeTrace = null;
  }
}

// Route-exit abandons currently deferred; see scheduleRouteExitAbandon.
const pendingRouteExitAbandons = new Set<string>();

/**
 * scheduleRouteExitAbandon abandons the channel's trace one microtask from
 * now unless cancelRouteExitAbandon runs first. Call it from the route-exit
 * effect cleanup: deferring lets React StrictMode's dev-only effect replay
 * — cleanup + re-setup, synchronously within one commit — cancel the
 * abandon, where abandoning synchronously would kill every just-opened
 * trace in dev builds and break the Performance-panel workflow. A real
 * route exit has no re-setup, so the scheduled abandon still fires — and
 * microtasks run before any frame callback, so a queued settle cannot
 * record in the gap.
 */
export function scheduleRouteExitAbandon(channelId: string): void {
  pendingRouteExitAbandons.add(channelId);
  queueMicrotask(() => {
    if (pendingRouteExitAbandons.delete(channelId)) {
      abandonChannelSwitchTrace(channelId);
    }
  });
}

/**
 * cancelRouteExitAbandon revokes a pending scheduleRouteExitAbandon for the
 * channel. Call it from the route-enter effect setup, before any work.
 */
export function cancelRouteExitAbandon(channelId: string): void {
  pendingRouteExitAbandons.delete(channelId);
}

export function beginChannelSwitchTrace(channelId: string): void {
  if (typeof performance === "undefined") return;
  activeTrace = {
    channelId,
    startedAt: performance.now(),
    routeCommitAt: null,
    windowFetch: null,
    membersFetch: null,
  };
  performance.mark(CHANNEL_SWITCH_START_MARK, { detail: { channelId } });
}

export function markChannelSwitchRouteCommit(channelId: string): void {
  if (typeof performance === "undefined") return;
  if (!activeTrace || activeTrace.channelId !== channelId) return;
  if (activeTrace.routeCommitAt !== null) return;
  activeTrace.routeCommitAt = performance.now();
}

/**
 * A fetch attributes to the active trace only when it targets the traced
 * channel AND started after the switch began. A fetch that started before
 * the switch (e.g. the first leg of a rapid A→B→A completing during the
 * second A trace) is not this switch's cost; letting it claim the `??=`
 * slot would also block the real fetch. Pure for unit testing.
 */
export function shouldAttributeFetch(
  trace: ChannelSwitchTrace | null,
  channelId: string,
  fetchStartedAt: number,
): trace is ChannelSwitchTrace {
  if (!trace || trace.channelId !== channelId) return false;
  return fetchStartedAt >= trace.startedAt;
}

export function traceChannelWindowFetch(
  channelId: string,
  eventCount: number,
  durationMs: number,
  fetchStartedAt: number,
): void {
  if (!shouldAttributeFetch(activeTrace, channelId, fetchStartedAt)) return;
  activeTrace.windowFetch ??= { durationMs, eventCount };
}

export function traceChannelMembersFetch(
  channelId: string,
  memberCount: number,
  durationMs: number,
  fetchStartedAt: number,
): void {
  if (!shouldAttributeFetch(activeTrace, channelId, fetchStartedAt)) return;
  activeTrace.membersFetch ??= { durationMs, memberCount };
}

/**
 * Drops any active trace. Community switches remount the app shell but this
 * module-level singleton survives; channel ids are community-scoped, so a
 * stale trace could adopt the next community's fetches. Wired into
 * resetCommunityState() like every community-scoped singleton.
 */
export function resetChannelSwitchTrace(): void {
  activeTrace = null;
  pendingRouteExitAbandons.clear();
}

/** Bound on waiting for the deferred timeline commit before recording. */
const SETTLE_RENDER_WAIT_MS = 5_000;

/**
 * Per-frame decision for the bounded settle wait: keep waiting only while
 * the deferred render is still pending AND the deadline hasn't passed. When
 * the wait ends with the render still pending, the record must say so — the
 * >deadline tail is exactly what this tracer exists to expose, so the
 * measurement is kept but flagged rather than posing as an honest settled
 * paint. A trace older than the settle-entry timeout plus the render wait
 * is frame-starved (hidden window, display sleep — rAF suspends there) and
 * is dropped: nothing legitimate can reach that age, and recording it would
 * charge the whole absence to the switch. Pure for unit testing.
 */
export function resolveSettleWait(
  now: number,
  waitDeadline: number,
  renderPending: boolean,
  startedAt: number,
): "wait" | "drop" | { settleWaitTruncated: boolean } {
  if (now - startedAt > SWITCH_TRACE_TIMEOUT_MS + SETTLE_RENDER_WAIT_MS) {
    return "drop";
  }
  if (renderPending && now < waitDeadline) return "wait";
  return { settleWaitTruncated: renderPending };
}

/**
 * Closes the active trace once the settled frame has painted. The timeline
 * renders rows through a deferred snapshot that exposes
 * `data-render-pending` until the low-priority commit catches up, and the
 * lazy channel pane's Suspense fallback carries the same marker while its
 * chunk is still loading — waiting for both (bounded) keeps `totalMs`
 * honest on render-heavy and cold-chunk switches; a final rAF pair then
 * lands the mark after the browser paints.
 */
export function settleChannelSwitchTrace(channelId: string): void {
  if (typeof performance === "undefined") return;
  const { settledTrace, clearActive } = resolveSettleAction(
    activeTrace,
    channelId,
    performance.now(),
  );
  if (!settledTrace) {
    if (clearActive) activeTrace = null;
    return;
  }
  const trace = settledTrace;
  if (typeof window === "undefined") {
    activeTrace = null;
    return;
  }
  // rAF suspends entirely in hidden windows: a queued settle would fire
  // only when the user returns, charging the whole absence to the switch as
  // a clean record. Drop at settle when already hidden, and poison the wait
  // if the window hides before the record lands — better no measurement
  // than a fabricated one.
  if (document.visibilityState === "hidden") {
    activeTrace = null;
    return;
  }
  let hiddenDuringWait = false;
  const onVisibilityChange = () => {
    hiddenDuringWait = true;
  };
  document.addEventListener("visibilitychange", onVisibilityChange, {
    once: true,
  });
  const stopWatchingVisibility = () => {
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
  // Keep the trace active through the deferred-commit wait so fetches that
  // finish inside the measured window still attribute to it. It is released
  // when the record lands; a newer switch's begin() simply replaces it.
  const waitDeadline = performance.now() + SETTLE_RENDER_WAIT_MS;
  const record = (settleWaitTruncated: boolean) => {
    const settledAt = performance.now();
    if (activeTrace === trace) activeTrace = null;
    // Keep only the latest switch in the User Timing buffer: desktop
    // sessions run for weeks and the buffer is never GC'd. DevTools
    // recordings capture entries at emit time, so clearing loses nothing.
    performance.clearMarks(CHANNEL_SWITCH_START_MARK);
    performance.clearMarks(CHANNEL_SWITCH_SETTLED_MARK);
    performance.clearMeasures(CHANNEL_SWITCH_MEASURE);
    performance.mark(CHANNEL_SWITCH_SETTLED_MARK, {
      detail: { channelId },
    });
    performance.measure(CHANNEL_SWITCH_MEASURE, {
      detail: {
        channelId,
        routeCommitAt: trace.routeCommitAt,
        windowFetch: trace.windowFetch,
        membersFetch: trace.membersFetch,
        ...(settleWaitTruncated ? { settleWaitTruncated: true } : {}),
      },
      start: trace.startedAt,
      end: settledAt,
    });
    console.info(
      summarizeChannelSwitchTrace(trace, settledAt, settleWaitTruncated),
    );
    appendSwitchPerfLogRecord(
      buildSwitchPerfLogRecord(trace, settledAt, settleWaitTruncated),
    );
  };
  const dropTrace = () => {
    stopWatchingVisibility();
    if (activeTrace === trace) activeTrace = null;
  };
  const awaitDeferredCommit = () => {
    if (activeTrace !== trace) {
      // A newer switch replaced this trace, or a community reset dropped it.
      // Either way the paint this callback would sample is not this switch's
      // own — recording would charge the replacement's delay to the settled
      // channel and could manufacture the very regression the tracer exists
      // to diagnose. Better no measurement than a fabricated one.
      stopWatchingVisibility();
      return;
    }
    if (hiddenDuringWait) {
      dropTrace();
      return;
    }
    const decision = resolveSettleWait(
      performance.now(),
      waitDeadline,
      document.querySelector('[data-render-pending="true"]') !== null,
      trace.startedAt,
    );
    if (decision === "wait") {
      window.requestAnimationFrame(awaitDeferredCommit);
      return;
    }
    if (decision === "drop") {
      dropTrace();
      return;
    }
    window.requestAnimationFrame(() => {
      if (activeTrace !== trace) {
        stopWatchingVisibility();
        return;
      }
      if (hiddenDuringWait) {
        dropTrace();
        return;
      }
      stopWatchingVisibility();
      record(decision.settleWaitTruncated);
    });
  };
  window.requestAnimationFrame(awaitDeferredCommit);
}
