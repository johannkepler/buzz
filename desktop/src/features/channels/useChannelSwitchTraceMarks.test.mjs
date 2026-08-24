import assert from "node:assert/strict";
import { afterEach, it } from "node:test";

import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

import {
  CHANNEL_SWITCH_MEASURE,
  beginChannelSwitchTrace,
  resetChannelSwitchTrace,
  settleChannelSwitchTrace,
} from "../../shared/lib/channelSwitchPerf.ts";
import { useChannelSwitchTraceMarks } from "./useChannelSwitchTraceMarks.ts";

// These tests run the hook under the real react-dom development build, whose
// StrictMode replays every effect (setup → cleanup → setup) on mount — the
// exact dev-runtime lifecycle that used to abandon a just-opened trace and
// break the Performance-panel workflow.

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;

afterEach(() => {
  resetChannelSwitchTrace();
  performance.clearMeasures?.(CHANNEL_SWITCH_MEASURE);
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
  if (originalActEnvironment === undefined)
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  else globalThis.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
});

function setupDom() {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='root'></div></body></html>",
  );
  const frames = [];
  dom.window.requestAnimationFrame = (cb) => frames.push(cb) && frames.length;
  dom.window.cancelAnimationFrame = () => {};
  Object.assign(globalThis, {
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  });
  const flushFrames = () => {
    // Drain chained rAFs until quiescent.
    for (let i = 0; i < 20 && frames.length > 0; i += 1) {
      for (const cb of frames.splice(0, frames.length)) cb();
    }
  };
  return { dom, flushFrames };
}

function Harness({ channelId, isTimelineLoading }) {
  useChannelSwitchTraceMarks({
    activeChannelId: channelId,
    activeChannelType: "stream",
    isTimelineLoading,
  });
  return null;
}

function renderHarness(root, props) {
  return act(async () =>
    root.render(
      React.createElement(
        React.StrictMode,
        null,
        React.createElement(Harness, props),
      ),
    ),
  );
}

const measures = () =>
  performance
    .getEntriesByName(CHANNEL_SWITCH_MEASURE)
    .map((entry) => entry.detail?.channelId);

it("a trace survives StrictMode's effect replay and still settles", async () => {
  const { dom, flushFrames } = setupDom();
  performance.clearMeasures?.(CHANNEL_SWITCH_MEASURE);
  beginChannelSwitchTrace("chan-strict");
  const root = createRoot(document.getElementById("root"));
  await renderHarness(root, {
    channelId: "chan-strict",
    isTimelineLoading: true,
  });
  await renderHarness(root, {
    channelId: "chan-strict",
    isTimelineLoading: false,
  });
  flushFrames();
  assert.deepEqual(measures(), ["chan-strict"]);
  await act(async () => root.unmount());
  dom.window.close();
});

it("a real route exit still abandons: a history-back settle records nothing", async () => {
  const { dom, flushFrames } = setupDom();
  performance.clearMeasures?.(CHANNEL_SWITCH_MEASURE);
  beginChannelSwitchTrace("chan-exit");
  const root = createRoot(document.getElementById("root"));
  await renderHarness(root, {
    channelId: "chan-exit",
    isTimelineLoading: true,
  });
  // Leaving the channel surface unmounts the hook; with no re-setup to
  // cancel it, the scheduled abandon must fire.
  await act(async () => root.unmount());
  await new Promise((resolve) => setImmediate(resolve));
  // History-back re-enters without goChannel; its settle must find no trace.
  settleChannelSwitchTrace("chan-exit");
  flushFrames();
  assert.deepEqual(measures(), []);
  dom.window.close();
});

it("an A→B switch's deferred abandon of A never kills B's trace", async () => {
  const { dom, flushFrames } = setupDom();
  performance.clearMeasures?.(CHANNEL_SWITCH_MEASURE);
  beginChannelSwitchTrace("chan-a");
  const root = createRoot(document.getElementById("root"));
  await renderHarness(root, { channelId: "chan-a", isTimelineLoading: true });
  beginChannelSwitchTrace("chan-b");
  await renderHarness(root, { channelId: "chan-b", isTimelineLoading: true });
  await renderHarness(root, { channelId: "chan-b", isTimelineLoading: false });
  flushFrames();
  assert.deepEqual(measures(), ["chan-b"]);
  await act(async () => root.unmount());
  dom.window.close();
});
