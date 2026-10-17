import { afterEach, describe, expect, it, vi } from "vitest";
import { initSandboxRuntimeModular } from "./init";
import { createMockTimeline, resetRuntimeFixtureDom } from "./runtimeSeekFixture.test-helpers";

function mountPlayer(videoAttrs: string, sourceDuration: number) {
  resetRuntimeFixtureDom();
  let now = 0;
  let id = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callbacks.set(++id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((key) => {
    callbacks.delete(key);
  });
  const step = (frames: number) => {
    for (let i = 0; i < frames; i++) {
      now += 100;
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback(now);
    }
  };
  document.body.innerHTML = `<div data-composition-id="main" data-root="true" data-duration="10"><video data-start="0" data-duration="10" ${videoAttrs} src="/movie.mp4"></video></div>`;
  const video = document.querySelector("video")!;
  // A decoder in step with the mocked clock: its position advances at its rate while unpaused.
  const seeks: number[] = [];
  let position = 0;
  let anchor = 0;
  let paused = true;
  let rate = 1;
  const read = () => (paused ? position : position + ((now - anchor) / 1000) * rate);
  const reanchor = () => {
    position = read();
    anchor = now;
  };
  Object.defineProperties(video, {
    currentTime: {
      get: read,
      set: (t: number) => {
        seeks.push(t);
        position = t;
        anchor = now;
      },
      configurable: true,
    },
    paused: { get: () => paused, configurable: true },
    playbackRate: {
      get: () => rate,
      set: (r: number) => {
        reanchor();
        rate = r;
      },
      configurable: true,
    },
    duration: { value: sourceDuration, configurable: true },
    readyState: { value: 4, configurable: true },
  });
  video.play = vi.fn(() => {
    reanchor();
    paused = false;
    return Promise.resolve();
  });
  video.pause = vi.fn(() => {
    reanchor();
    paused = true;
  });
  video.load = vi.fn();
  window.__timelines = { main: createMockTimeline(10) };
  initSandboxRuntimeModular();
  return { player: window.__player!, video, step, seeks };
}

afterEach(() => {
  window.__hfRuntimeTeardown?.();
  vi.restoreAllMocks();
  resetRuntimeFixtureDom();
});

describe.each([
  // name, attributes, source seconds, source time at t=5, at t=5.5, rate
  ["a clip at its own rate", "", 20, 5, 5.5, 1],
  ["a clip at 2x", 'data-playback-rate="2"', 20, 10, 11, 2],
  ["a looping clip", "loop", 4, 1, 1.5, 1],
])("%s", (_name, attrs, sourceDuration, atFive, atFiveAndAHalf, rate) => {
  it("lands at its source time in one seek when play is pressed", () => {
    const { player, video, step, seeks } = mountPlayer(attrs, sourceDuration);
    player.seek(5);
    seeks.length = 0;
    player.play();
    step(3);
    expect(seeks).toEqual([atFive]);
    expect(video.currentTime).toBeCloseTo(atFive + 0.3 * rate, 5);
  });

  it("lands at its source time in one seek when seeked while playing", () => {
    const { player, video, step, seeks } = mountPlayer(attrs, sourceDuration);
    player.play();
    step(10);
    seeks.length = 0;
    player.seek(5.5, { keepPlaying: true });
    step(3);
    expect(player.isPlaying()).toBe(true);
    expect(seeks).toEqual([atFiveAndAHalf]);
    expect(video.currentTime).toBeCloseTo(atFiveAndAHalf + 0.3 * rate, 5);
  });
});
