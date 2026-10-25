import { afterEach, describe, expect, it } from "vitest";
import type { Page } from "puppeteer-core";
import {
  MAX_RISK_FRAME_FRACTION,
  RISK_RANGE_HYSTERESIS_FRAMES,
  planRiskFrames,
  scanCssEffectLiveFrames,
} from "./riskFrames.js";

describe("planRiskFrames", () => {
  it("adds a one-frame margin around each range", () => {
    expect([...(planRiskFrames([50, 51], 1000) ?? [])]).toEqual([49, 50, 51, 52]);
  });

  it("clamps the margin to the render", () => {
    expect([...(planRiskFrames([0, 99], 100) ?? [])].sort((a, b) => a - b)).toEqual(
      expect.arrayContaining([0, 1, 98, 99]),
    );
  });

  it("joins ranges closer than the hysteresis so capture never alternates modes", () => {
    const gap = RISK_RANGE_HYSTERESIS_FRAMES;
    const plan = planRiskFrames([100, 100 + gap], 10_000);
    expect(plan?.has(100 + Math.floor(gap / 2))).toBe(true);
  });

  it("keeps ranges farther apart than the hysteresis separate", () => {
    const gap = RISK_RANGE_HYSTERESIS_FRAMES + 1;
    const plan = planRiskFrames([100, 100 + gap], 10_000);
    expect(plan?.has(100 + Math.floor(gap / 2))).toBe(false);
  });

  it("gives no plan when risk frames cover most of the render", () => {
    const frames = Array.from(
      { length: Math.ceil(100 * MAX_RISK_FRAME_FRACTION) + 1 },
      (_, i) => i,
    );
    expect(planRiskFrames(frames, 100)).toBeNull();
  });

  it("plans nothing for no risk frames", () => {
    expect(planRiskFrames([], 100)?.size).toBe(0);
  });
});

interface Seek {
  t: number;
  suppressEvents?: boolean;
}

const GLOBALS = ["document", "window", "getComputedStyle"] as const;
const saved = new Map<string, unknown>();

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  for (const [k, v] of saved) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
  saved.clear();
});

/** A page whose one effect element shows from `showFrom` to `showTo` seconds. */
function makePage(showFrom: number, showTo: number, seeks: Seek[]): Page {
  let now = 0;
  const parent = { parentElement: null };
  const el = { parentElement: parent };
  const win = {
    __hfCssFxTargets: [el],
    __hf: {
      seek: (t: number, options?: { suppressEvents?: boolean }) => {
        now = t;
        seeks.push({ t, suppressEvents: options?.suppressEvents });
      },
    },
  };
  const computed = (n: unknown) => {
    const shown = now >= showFrom && now < showTo;
    return n === el
      ? { visibility: shown ? "visible" : "hidden", display: "block", opacity: "1" }
      : { visibility: "visible", display: "block", opacity: "1" };
  };
  return {
    evaluate: async (fn: (...a: unknown[]) => unknown, ...args: unknown[]) => {
      const g = globalThis as Record<string, unknown>;
      for (const k of GLOBALS) if (!saved.has(k)) saved.set(k, g[k]);
      g.window = win;
      g.document = {};
      g.getComputedStyle = computed;
      return fn(...args);
    },
  } as unknown as Page;
}

describe("scanCssEffectLiveFrames", () => {
  it("returns the frames where an effect element shows and rewinds to frame 0", async () => {
    const seeks: Seek[] = [];
    const live = await scanCssEffectLiveFrames(makePage(2, 4, seeks), 10, 100, 100);
    expect([...(live ?? [])].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => 20 + i),
    );
    expect(seeks.slice(0, 3).map((s) => s.t)).toEqual([0, 0.1, 0.2]);
    expect(seeks[seeks.length - 1]).toEqual({ t: 0, suppressEvents: true });
    expect(seeks.every((s) => s.suppressEvents)).toBe(true);
  });

  it("gives up once more frames qualify than the cap", async () => {
    expect(await scanCssEffectLiveFrames(makePage(0, 100, []), 10, 100, 10)).toBeNull();
  });
});
