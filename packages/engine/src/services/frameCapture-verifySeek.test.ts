import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "puppeteer-core";
import { seekDeVerifyTruth } from "./frameCapture.js";

describe("seekDeVerifyTruth", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("seeks with timeline callbacks running, as the render's own seek does", async () => {
    const seek = vi.fn();
    vi.stubGlobal("window", { __hf: { seek } });
    const page = {
      evaluate: async (fn: (t: number) => void, t: number) => fn(t),
    } as unknown as Page;

    await seekDeVerifyTruth(page, 5);

    expect(seek).toHaveBeenCalledWith(5, { suppressEvents: false });
  });

  it("does nothing on a page without the seek protocol", async () => {
    vi.stubGlobal("window", {});
    const page = {
      evaluate: async (fn: (t: number) => void, t: number) => fn(t),
    } as unknown as Page;

    await expect(seekDeVerifyTruth(page, 5)).resolves.toBeUndefined();
  });
});
