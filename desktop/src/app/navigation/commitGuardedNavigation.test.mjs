import assert from "node:assert/strict";
import test from "node:test";

import { commitGuardedNavigation } from "./commitGuardedNavigation.ts";
import { registerNavigationGuard, traverseHistory } from "./navigationGuard.ts";
import {
  CHANNEL_SWITCH_MEASURE,
  beginChannelSwitchTrace,
  resetChannelSwitchTrace,
  settleChannelSwitchTrace,
} from "../../shared/lib/channelSwitchPerf.ts";

const route = (href) => ({ kind: "route", href });

// Frame/document stubs so settle's rAF chain can be driven synchronously.
function withTraceHarness(run) {
  const frames = [];
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  globalThis.window = {
    requestAnimationFrame: (cb) => frames.push(cb) && frames.length,
    cancelAnimationFrame: () => {},
  };
  globalThis.document = {
    addEventListener: () => {},
    querySelector: () => null,
    removeEventListener: () => {},
    visibilityState: "visible",
  };
  performance.clearMeasures?.(CHANNEL_SWITCH_MEASURE);
  const flush = () => {
    for (let i = 0; i < 20 && frames.length > 0; i += 1) {
      for (const cb of frames.splice(0, frames.length)) cb();
    }
  };
  const measures = () =>
    performance
      .getEntriesByName(CHANNEL_SWITCH_MEASURE)
      .map((entry) => entry.detail?.channelId);
  return (async () => {
    try {
      await run({ flush, measures });
    } finally {
      resetChannelSwitchTrace();
      performance.clearMeasures?.(CHANNEL_SWITCH_MEASURE);
      if (originalWindow === undefined) delete globalThis.window;
      else globalThis.window = originalWindow;
      if (originalDocument === undefined) delete globalThis.document;
      else globalThis.document = originalDocument;
    }
  })();
}

test("a committed non-channel navigation drops the active trace", async () => {
  await withTraceHarness(async ({ flush, measures }) => {
    // A trace can be live with no channel screen mounted at all (the route
    // still resolving), so no route-exit cleanup exists to abandon it — the
    // navigation layer must drop it, or a history-back re-entry within the
    // 30s timeout would settle it with the time spent away.
    beginChannelSwitchTrace("bbbb");
    const committed = await commitGuardedNavigation({
      currentHref: "/channels/bbbb",
      nextHref: "/",
      guardedTarget: route("/"),
      leavesChannelSurface: true,
      navigate: async () => {},
    });
    assert.equal(committed, true);
    settleChannelSwitchTrace("bbbb");
    flush();
    assert.deepEqual(measures(), []);
  });
});

test("a same-channel navigation never drops the channel's live trace", async () => {
  await withTraceHarness(async ({ flush, measures }) => {
    beginChannelSwitchTrace("bbbb");
    // Jump-to-message within the active channel: untraced, but must not
    // kill the in-flight trace either.
    await commitGuardedNavigation({
      currentHref: "/channels/bbbb",
      nextHref: "/channels/bbbb?messageId=m1",
      guardedTarget: route("/channels/bbbb?messageId=m1"),
      leavesChannelSurface: false,
      navigate: async () => {},
    });
    settleChannelSwitchTrace("bbbb");
    flush();
    assert.deepEqual(measures(), ["bbbb"]);
  });
});

test("history traversal drops the active trace", async () => {
  await withTraceHarness(async ({ flush, measures }) => {
    beginChannelSwitchTrace("bbbb");
    const calls = [];
    // History navigation is deliberately untraced and its destination is
    // unknowable here — a live trace must not survive into it.
    traverseHistory(
      { back: () => calls.push("back"), forward: () => {} },
      "back",
    );
    assert.deepEqual(calls, ["back"]);
    settleChannelSwitchTrace("bbbb");
    flush();
    assert.deepEqual(measures(), []);
  });
});

test("a refused navigation opens no trace; a later history settle records nothing", async () => {
  // Frame-queue stub so the settle's rAF chain can be drained synchronously.
  const frames = [];
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  globalThis.window = {
    requestAnimationFrame: (cb) => frames.push(cb) && frames.length,
    cancelAnimationFrame: () => {},
  };
  globalThis.document = {
    addEventListener: () => {},
    querySelector: () => null,
    removeEventListener: () => {},
    visibilityState: "visible",
  };
  performance.clearMeasures?.(CHANNEL_SWITCH_MEASURE);
  const unregister = registerNavigationGuard(() => false);
  try {
    let navigated = false;
    const committed = await commitGuardedNavigation({
      currentHref: "/channels/aaaa",
      nextHref: "/channels/bbbb",
      guardedTarget: route("/channels/bbbb"),
      traceChannelId: "bbbb",
      navigate: async () => {
        navigated = true;
      },
    });
    assert.equal(committed, false);
    assert.equal(navigated, false);

    // Browser Back into the refused channel (history navigation is
    // deliberately untraced): its mount settles, and must find NO orphan
    // trace from the refused click — otherwise the measure would span the
    // refusal and everything the user did in between.
    settleChannelSwitchTrace("bbbb");
    for (let i = 0; i < 20 && frames.length > 0; i += 1) {
      for (const cb of frames.splice(0, frames.length)) cb();
    }
    assert.deepEqual(
      performance
        .getEntriesByName(CHANNEL_SWITCH_MEASURE)
        .map((entry) => entry.detail?.channelId),
      [],
    );
  } finally {
    unregister();
    resetChannelSwitchTrace();
    performance.clearMeasures?.(CHANNEL_SWITCH_MEASURE);
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test("an accepted navigation opens the trace after the guard, before navigate", async () => {
  const order = [];
  const committed = await commitGuardedNavigation(
    {
      currentHref: "/channels/aaaa",
      nextHref: "/channels/bbbb",
      guardedTarget: route("/channels/bbbb"),
      traceChannelId: "bbbb",
      navigate: async () => {
        order.push("navigate");
      },
    },
    {
      allow: () => {
        order.push("guard");
        return true;
      },
      beginTrace: (channelId) => {
        order.push(`begin:${channelId}`);
      },
    },
  );
  assert.equal(committed, true);
  assert.deepEqual(order, ["guard", "begin:bbbb", "navigate"]);
});

test("a same-destination no-op consults neither the guard nor the trace", async () => {
  const order = [];
  const committed = await commitGuardedNavigation(
    {
      currentHref: "/channels/aaaa",
      nextHref: "/channels/aaaa",
      guardedTarget: route("/channels/aaaa"),
      traceChannelId: "aaaa",
      navigate: async () => {
        order.push("navigate");
      },
    },
    {
      allow: () => {
        order.push("guard");
        return true;
      },
      beginTrace: () => {
        order.push("begin");
      },
    },
  );
  assert.equal(committed, false);
  assert.deepEqual(order, []);
});

test("force overrides the same-destination no-op but still runs the guard first", async () => {
  const order = [];
  const committed = await commitGuardedNavigation(
    {
      currentHref: "/channels/aaaa",
      nextHref: "/channels/aaaa",
      force: true,
      guardedTarget: route("/channels/aaaa"),
      navigate: async () => {
        order.push("navigate");
      },
    },
    {
      allow: () => {
        order.push("guard");
        return true;
      },
      beginTrace: () => {
        order.push("begin");
      },
    },
  );
  assert.equal(committed, true);
  // No traceChannelId: forced re-selection of the active channel stays
  // untraced (nothing would settle it).
  assert.deepEqual(order, ["guard", "navigate"]);
});

test("a same-destination navigation carrying router state still commits", async () => {
  const order = [];
  const committed = await commitGuardedNavigation(
    {
      currentHref: "/channels/aaaa",
      nextHref: "/channels/aaaa",
      guardedTarget: route("/channels/aaaa"),
      hasStateUpdate: true,
      navigate: async () => {
        order.push("navigate");
      },
    },
    {
      allow: () => {
        order.push("guard");
        return true;
      },
      beginTrace: () => {
        order.push("begin");
      },
    },
  );
  assert.equal(committed, true);
  assert.deepEqual(order, ["guard", "navigate"]);
});
