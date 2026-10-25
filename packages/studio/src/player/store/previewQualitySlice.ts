import type { StoreApi } from "zustand";
import type { PreviewQuality } from "@hyperframes/core";
import { readStudioUiPreferences, writeStudioUiPreferences } from "../../utils/studioUiPreferences";

/** The lighter copies of heavy videos the preview wants at its current quality. */
export interface PreviewCopies {
  total: number;
  ready: number;
  failed: number;
  progress: number | null;
  error: string | null;
}

export type PreviewQualityChosenBy = "person" | "app";

export interface PreviewQualitySlice {
  previewQuality: PreviewQuality;
  /** Who set the level: a person (saved level, or a pick) or the app (never saved); null while nothing has. */
  previewQualityChosenBy: PreviewQualityChosenBy | null;
  /** A person's pick is saved; `by: "app"` sets the level without saving it and never overrides a saved pick. */
  setPreviewQuality: (level: PreviewQuality, options?: { by?: PreviewQualityChosenBy }) => void;
  /** Null when no copies are wanted: full quality, or nothing heavy. */
  previewCopies: PreviewCopies | null;
  setPreviewCopies: (copies: PreviewCopies | null) => void;
  /** Bumped by retryPreviewCopies; the preview owner forwards each bump to the runtime. */
  previewCopiesRetry: number;
  retryPreviewCopies: () => void;
}

export function createPreviewQualitySlice(
  set: StoreApi<PreviewQualitySlice>["setState"],
  get: StoreApi<PreviewQualitySlice>["getState"],
): PreviewQualitySlice {
  const saved = readStudioUiPreferences().previewQuality;
  return {
    previewQuality: saved ?? 1,
    previewQualityChosenBy: saved === undefined ? null : "person",
    setPreviewQuality: (previewQuality, options) => {
      if (options?.by === "app") {
        if (get().previewQualityChosenBy !== "person") {
          set({ previewQuality, previewQualityChosenBy: "app" });
        }
        return;
      }
      writeStudioUiPreferences({ previewQuality });
      set({ previewQuality, previewQualityChosenBy: "person" });
    },
    previewCopies: null,
    setPreviewCopies: (previewCopies) => set({ previewCopies }),
    previewCopiesRetry: 0,
    retryPreviewCopies: () =>
      set((state) => ({ previewCopiesRetry: state.previewCopiesRetry + 1 })),
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
