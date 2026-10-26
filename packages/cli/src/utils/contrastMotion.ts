export interface ContrastTweenWindow {
  start: number;
  end: number;
  duration: number;
  repeat: number;
}

export interface ContrastMotionSample {
  opacity: number;
  tweens: ContrastTweenWindow[];
}

/** A repeating tween or one this long is set dressing (a camera drift, a pulse), not an entrance or exit. */
const AMBIENT_TWEEN_SECONDS = 4;
const EPSILON = 1e-6;

function isAmbientTween(tween: ContrastTweenWindow): boolean {
  return tween.repeat !== 0 || tween.duration >= AMBIENT_TWEEN_SECONDS;
}

/** True when a non-ambient tween on the text or an ancestor is running at `time`, or the text is not fully opaque. */
export function measuredInMotion(sample: ContrastMotionSample, time: number): boolean {
  if (Math.round(sample.opacity * 1000) < 1000) return true;
  return sample.tweens.some(
    (tween) =>
      !isAmbientTween(tween) && tween.start <= time + EPSILON && time < tween.end - EPSILON,
  );
}

/**
 * Runs in the page after `__contrastAuditPrepare` (serialized by puppeteer, so it is self-contained): for each
 * prepared candidate, in order, the GSAP tweens on its element or an ancestor, timed on the composition
 * timeline, and the element's opacity multiplied up its ancestors. Null when no tween with a duration targets
 * the element or an ancestor, which includes a page without GSAP.
 */
// One serialized page function; its helpers cannot live outside it.
// fallow-ignore-next-line complexity
export function readContrastMotion(): (ContrastMotionSample | null)[] {
  type Animation = {
    parent: Animation | null;
    targets: () => unknown[];
    duration: () => number;
    totalDuration: () => number;
    repeat: () => number;
    globalTime: (localTime: number) => number;
    getChildren: (nested: boolean, tweens: boolean, timelines: boolean) => Animation[];
  };
  const restores: unknown = Reflect.get(window, "__contrastAuditRestores");
  const registry: unknown = Reflect.get(window, "__timelines");
  const timelines = Object.values(typeof registry === "object" && registry ? registry : {}).filter(
    (timeline): timeline is Animation =>
      typeof timeline?.getChildren === "function" && typeof timeline.globalTime === "function",
  );
  const registered = new Set<Animation>(timelines);
  const byTarget = new Map<Element, ContrastTweenWindow[]>();

  function nestedInAnother(timeline: Animation): boolean {
    for (let parent = timeline.parent; parent; parent = parent.parent) {
      if (registered.has(parent)) return true;
    }
    return false;
  }

  function addTweens(timeline: Animation): void {
    const origin = timeline.globalTime(0);
    for (const tween of timeline.getChildren(true, true, false)) {
      const total = tween.totalDuration();
      if (!(total > 0)) continue;
      const window = {
        start: tween.globalTime(0) - origin,
        end: tween.globalTime(total) - origin,
        duration: tween.duration(),
        repeat: tween.repeat(),
      };
      for (const target of tween.targets()) {
        if (target instanceof Element)
          byTarget.set(target, [...(byTarget.get(target) ?? []), window]);
      }
    }
  }

  function sampleOf(element: unknown): ContrastMotionSample | null {
    if (!(element instanceof Element)) return null;
    const tweens: ContrastTweenWindow[] = [];
    let opacity = 1;
    for (let node: Element | null = element; node; node = node.parentElement) {
      tweens.push(...(byTarget.get(node) ?? []));
      const own = Number.parseFloat(getComputedStyle(node).opacity);
      if (Number.isFinite(own)) opacity *= own;
    }
    return tweens.length > 0 ? { opacity, tweens } : null;
  }

  for (const timeline of timelines) {
    try {
      if (!nestedInAnother(timeline)) addTweens(timeline);
    } catch {
      continue;
    }
  }
  return (Array.isArray(restores) ? restores : []).map((restore) =>
    typeof restore === "object" && restore ? sampleOf(Reflect.get(restore, "el")) : null,
  );
}
