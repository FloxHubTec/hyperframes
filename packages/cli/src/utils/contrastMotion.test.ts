// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  measuredInMotion,
  readContrastMotion,
  type ContrastTweenWindow,
} from "./contrastMotion.js";

type FakeAnimation = {
  parent: FakeAnimation | null;
  targets: () => unknown[];
  duration: () => number;
  totalDuration: () => number;
  repeat: () => number;
  globalTime: (localTime: number) => number;
  getChildren?: () => FakeAnimation[];
  add?: (child: FakeAnimation) => void;
};

function fakeTimeline(at: number, parent: FakeAnimation | null = null): FakeAnimation {
  const children: FakeAnimation[] = [];
  const timeline: FakeAnimation = {
    parent,
    targets: () => [],
    duration: () => 0,
    totalDuration: () => 0,
    repeat: () => 0,
    globalTime: (local) => at + local,
    getChildren: () =>
      children.flatMap((child) => (child.getChildren ? [child, ...child.getChildren()] : [child])),
    add: (child) => {
      children.push(child);
    },
  };
  parent?.add?.(timeline);
  return timeline;
}

function fakeTween(
  parent: FakeAnimation,
  target: unknown,
  start: number,
  duration: number,
  repeat = 0,
): void {
  const total = repeat < 0 ? 1e10 : duration * (repeat + 1);
  parent.add?.({
    parent,
    targets: () => [target],
    duration: () => duration,
    totalDuration: () => total,
    repeat: () => repeat,
    globalTime: (local) => parent.globalTime(start) + local,
  });
}

function window_(start: number, end: number, repeat = 0): ContrastTweenWindow {
  return { start, end, duration: end - start, repeat };
}

function stage(labelOpacity: number): { cam: HTMLElement; card: HTMLElement; label: HTMLElement } {
  document.body.innerHTML = `<div id="cam"><div id="card"><span id="label" style="opacity:${labelOpacity}">Revenue</span></div></div><span id="other">Other</span>`;
  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  return { cam: byId("cam"), card: byId("card"), label: byId("label") };
}

function prepared(...elements: Element[]): void {
  Reflect.set(
    window,
    "__contrastAuditRestores",
    elements.map((el) => ({ el })),
  );
}

describe("measuredInMotion", () => {
  it("is in motion inside a tween and at rest after it", () => {
    const sample = { opacity: 1, tweens: [window_(1, 1.6)] };
    expect(measuredInMotion(sample, 1.3)).toBe(true);
    expect(measuredInMotion(sample, 3)).toBe(false);
  });

  it("counts partial opacity even at rest", () => {
    expect(measuredInMotion({ opacity: 0.6, tweens: [window_(1, 1.6)] }, 3)).toBe(true);
    expect(measuredInMotion({ opacity: 0.9996, tweens: [window_(1, 1.6)] }, 3)).toBe(false);
  });

  it("does not count a repeating tween or a 4 s drift as motion", () => {
    const tweens = [window_(0, 4), window_(0, 1e10, -1), { ...window_(0, 3), repeat: 2 }];
    expect(measuredInMotion({ opacity: 1, tweens }, 2)).toBe(false);
  });
});

describe("readContrastMotion", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "__timelines");
    Reflect.deleteProperty(window, "__contrastAuditRestores");
    document.body.innerHTML = "";
  });

  it("reads a fading label's tween on the composition clock and its opacity chain", () => {
    const { card, label } = stage(0.5);
    card.style.opacity = "0.8";
    const main = fakeTimeline(100);
    const scene = fakeTimeline(102, main);
    fakeTween(scene, label, 1, 0.6);
    Reflect.set(window, "__timelines", { main, scene });
    prepared(label);

    const [sample] = readContrastMotion();
    expect(sample?.opacity).toBeCloseTo(0.4, 6);
    expect(sample?.tweens).toHaveLength(1);
    expect(sample?.tweens[0]?.start).toBeCloseTo(3, 6);
    expect(sample?.tweens[0]?.end).toBeCloseTo(3.6, 6);
    expect(measuredInMotion(sample!, 3.3)).toBe(true);
    expect(measuredInMotion({ ...sample!, opacity: 1 }, 5)).toBe(false);
  });

  it("collects tweens on ancestors, and an ambient camera drift alone is not motion", () => {
    const { cam, label } = stage(1);
    const main = fakeTimeline(0);
    fakeTween(main, cam, 0, 4);
    Reflect.set(window, "__timelines", { main });
    prepared(label);

    const [sample] = readContrastMotion();
    expect(sample?.tweens).toHaveLength(1);
    expect(measuredInMotion(sample!, 2)).toBe(false);
  });

  it("is null for text no tween targets and for a page without GSAP", () => {
    const { label } = stage(1);
    const other = document.getElementById("other") as HTMLElement;
    prepared(label, other);
    expect(readContrastMotion()).toEqual([null, null]);

    const main = fakeTimeline(0);
    fakeTween(main, label, 0, 1);
    fakeTween(main, {}, 0, 1);
    Reflect.set(window, "__timelines", { main });
    const [animated, still] = readContrastMotion();
    expect(animated).not.toBeNull();
    expect(still).toBeNull();
  });
});
