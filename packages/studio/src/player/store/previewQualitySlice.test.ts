import { describe, expect, it } from "vitest";
import { usePlayerStore } from "./playerStore";
import { parsePreviewCopies } from "./previewQualitySlice";

describe("preview quality in the player store", () => {
  it("starts at full quality with no copies, and counts retries", () => {
    const state = usePlayerStore.getState();
    expect(state.previewQuality).toBe(1);
    expect(state.previewCopies).toBeNull();

    const before = state.previewCopiesRetry;
    state.retryPreviewCopies();
    expect(usePlayerStore.getState().previewCopiesRetry).toBe(before + 1);
  });

  it("reads a report of the copies only when it has the shape of one", () => {
    expect(
      parsePreviewCopies({ total: 2, ready: 1, failed: 1, progress: 0.75, error: "failed" }),
    ).toEqual({ total: 2, ready: 1, failed: 1, progress: 0.75, error: "failed" });
    expect(parsePreviewCopies(null)).toBeNull();
    expect(parsePreviewCopies({ total: "2", ready: 1, failed: 0, progress: 0 })).toBeNull();
    expect(parsePreviewCopies({ total: 2, ready: 1, failed: 0 })).toBeNull();
  });
});
