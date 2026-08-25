import assert from "node:assert/strict";
import test from "node:test";

import { commitGuardedNavigation } from "./commitGuardedNavigation.ts";
import { registerNavigationGuard } from "./navigationGuard.ts";
import {
  CHANNEL_SWITCH_MEASURE,
  resetChannelSwitchTrace,
  settleChannelSwitchTrace,
} from "../../shared/lib/channelSwitchPerf.ts";

const route = (href) => ({ kind: "route", href });

test("a refused navigation opens no trace; a later history settle records nothing", async () => {
  // Frame-queue stub so the settle's rAF chain can be drained synchronously.
  const frames = [];
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  globalThis.window = {
    requestAnimationFrame: (cb) => frames.push(cb) && frames.length,
    cancelAnimationFrame: () => {},
  };
  globalThis.document = { querySelector: () => null };
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
