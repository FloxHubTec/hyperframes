import gsap from "gsap";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initSandboxRuntimeModular } from "./init";
import type { RuntimeTimelineLike } from "./types";
import { resetRuntimeFixtureDom } from "./runtimeSeekFixture.test-helpers";

// A scene callback that throws must not stop the root timeline, in render as in preview.
describe("a scene callback that throws", () => {
  beforeEach(() => {
    resetRuntimeFixtureDom();
    window.gsap = gsap as unknown as typeof window.gsap;
  });

  afterEach(() => {
    window.__hfRuntimeTeardown?.();
    vi.restoreAllMocks();
    delete window.__player;
    delete window.__playerReady;
    delete window.__hf;
    delete window.__timelines;
  });

  /** Root moves `#late` at 3 s; the scene's onUpdate reads a missing element from 2 s on. */
  function load() {
    document.body.innerHTML =
      `<div data-composition-id="main" data-root="true" data-duration="6">` +
      `<div id="late"></div>` +
      `<div class="clip" data-composition-id="scene" data-start="0" data-duration="6">` +
      `<div id="dot"></div></div></div>`;
    const scene = gsap.timeline({
      paused: true,
      onUpdate() {
        if (scene.time() >= 2) document.querySelector("#missing")!.textContent = "late";
      },
    });
    scene.to("#dot", { x: 60, duration: 6, ease: "none" }, 0);
    const root = gsap.timeline({ paused: true });
    root.to("#late", { x: 100, duration: 0.1 }, 3);
    window.__timelines = { main: root, scene } as unknown as Record<string, RuntimeTimelineLike>;
    initSandboxRuntimeModular();
  }

  const x = (selector: string) => Number(gsap.getProperty(selector, "x"));

  it("still applies later root tweens on a render seek, and on a preview seek", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    load();

    window.__player!.renderSeek(4);
    expect(x("#late")).toBe(100);
    expect(x("#dot")).toBe(40);

    window.__player!.renderSeek(0);
    window.__player!.seek(4);
    expect(x("#late")).toBe(100);
  });

  it("reports the error once as a composition script error", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    load();

    for (const t of [1, 2.5, 3, 4]) window.__player!.renderSeek(t);

    const reported = errors.mock.calls.filter((args) =>
      String(args[0]).startsWith("[HyperFrames] composition script error:"),
    );
    expect(reported).toHaveLength(1);
    expect(reported[0]!.join(" ")).toContain("scene");
    expect(reported[0]!.join(" ")).toMatch(/textContent|null/);
  });
});
