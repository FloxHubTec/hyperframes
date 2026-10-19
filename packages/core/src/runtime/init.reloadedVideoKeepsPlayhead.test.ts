import { afterEach, expect, it, vi } from "vitest";
import { initSandboxRuntimeModular } from "./init";
import { evictMediaSyncState } from "./media";
import { createMockTimeline, resetRuntimeFixtureDom } from "./runtimeSeekFixture.test-helpers";

/** A loaded, paused video whose `load()` starts it over at 0, as a browser's does. */
function loadedVideo(el: HTMLVideoElement) {
  Object.defineProperty(el, "duration", { value: 6.27, configurable: true });
  Object.defineProperty(el, "readyState", { value: 4, configurable: true });
  Object.defineProperty(el, "paused", { value: true, writable: true, configurable: true });
  el.play = vi.fn(() => Promise.resolve());
  el.pause = vi.fn();
  el.load = vi.fn(() => {
    el.currentTime = 0;
  });
}

// A clip and its own cutout stacked at the same start: when the clip's authoring proxy (or that copy's larger size)
// loads while paused, the clip restarted at 0 and showed another moment of the person under the cutout.
it("a paused video that loads a new source goes back to the playhead, level with its stacked twin", () => {
  resetRuntimeFixtureDom();
  document.body.innerHTML =
    '<div data-composition-id="main" data-root="true" data-duration="6.27">' +
    '<video id="clip" data-start="0" data-duration="6.27" data-track-index="0" src="/clip.mp4"></video>' +
    '<video id="cutout" data-start="0" data-duration="6.27" data-track-index="2" muted src="/cutout.webm"></video>' +
    "</div>";
  const clip = document.getElementById("clip") as HTMLVideoElement;
  const cutout = document.getElementById("cutout") as HTMLVideoElement;
  loadedVideo(clip);
  loadedVideo(cutout);
  window.__timelines = { main: createMockTimeline(6.27) };
  initSandboxRuntimeModular();
  window.__player!.seek(4);
  expect(clip.currentTime).toBe(4);
  expect(cutout.currentTime).toBe(4);

  // What mediaProxy's loadProxy does to the clip, then the browser's answer once the copy's metadata is in.
  evictMediaSyncState(clip);
  clip.src = "/clip.mp4?hf-proxy=h264";
  clip.load();
  clip.dispatchEvent(new Event("loadedmetadata"));

  expect(clip.currentTime).toBe(4);
  expect(cutout.currentTime).toBe(4);
});

afterEach(() => {
  window.__hfRuntimeTeardown?.();
  vi.restoreAllMocks();
  resetRuntimeFixtureDom();
});
