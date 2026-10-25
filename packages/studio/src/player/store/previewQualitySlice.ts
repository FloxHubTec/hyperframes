import type { StoreApi } from "zustand";
import type { PreviewQuality } from "@hyperframes/core";

/** The lighter copies of heavy videos the preview wants at its current quality. */
export interface PreviewCopies {
  total: number;
  ready: number;
  failed: number;
  progress: number | null;
  error: string | null;
}

export interface PreviewQualitySlice {
  previewQuality: PreviewQuality;
  setPreviewQuality: (level: PreviewQuality) => void;
  /** Null when no copies are wanted: full quality, or nothing heavy. */
  previewCopies: PreviewCopies | null;
  setPreviewCopies: (copies: PreviewCopies | null) => void;
  /** Bumped by retryPreviewCopies; the preview owner forwards each bump to the runtime. */
  previewCopiesRetry: number;
  retryPreviewCopies: () => void;
}

export function createPreviewQualitySlice(
  set: StoreApi<PreviewQualitySlice>["setState"],
): PreviewQualitySlice {
  return {
    previewQuality: 1,
    setPreviewQuality: (previewQuality) => set({ previewQuality }),
    previewCopies: null,
    setPreviewCopies: (previewCopies) => set({ previewCopies }),
    previewCopiesRetry: 0,
    retryPreviewCopies: () => set((state) => ({ previewCopiesRetry: state.previewCopiesRetry + 1 })),
  };
}

/** The runtime's report, kept only when it has the shape of one. */
export function parsePreviewCopies(value: unknown): PreviewCopies | null {
  if (typeof value !== "object" || value === null) return null;
  const { total, ready, failed, progress, error } = value as Record<string, unknown>;
  const counts = [total, ready, failed].every((count) => typeof count === "number");
  if (!counts || typeof progress !== "number") return null;
  return {
    total: total as number,
    ready: ready as number,
    failed: failed as number,
    progress,
    error: typeof error === "string" ? error : null,
  };
}
