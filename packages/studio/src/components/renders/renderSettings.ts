import type { StartRenderHandler } from "./RenderQueue";
import type { ResolutionPreset } from "./useRenderQueue";

const RENDER_SETTINGS_KEY = "hf-studio-render-settings";

export interface PersistedRenderSettings {
  format: "mp4" | "webm" | "mov" | "gif";
  quality: "draft" | "standard" | "high";
  fps: 24 | 30 | 60;
  gpu: boolean;
}

export function getPersistedRenderSettings(): PersistedRenderSettings {
  try {
    const raw = localStorage.getItem(RENDER_SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        format: ["mp4", "webm", "mov", "gif"].includes(parsed.format) ? parsed.format : "mp4",
        quality: ["draft", "standard", "high"].includes(parsed.quality)
          ? parsed.quality
          : "standard",
        fps: [24, 30, 60].includes(parsed.fps) ? parsed.fps : 30,
        gpu: parsed.gpu === true,
      };
    }
  } catch {
    /* ignore */
  }
  return { format: "mp4", quality: "standard", fps: 30, gpu: false };
}

export function persistRenderSettings(
  format: PersistedRenderSettings["format"],
  quality: PersistedRenderSettings["quality"],
  fps: PersistedRenderSettings["fps"],
  gpu: boolean = getPersistedRenderSettings().gpu,
): void {
  try {
    localStorage.setItem(RENDER_SETTINGS_KEY, JSON.stringify({ format, quality, fps, gpu }));
  } catch {
    /* ignore */
  }
}

export function resolveRenderFormat(value: string): PersistedRenderSettings["format"] {
  return (["mp4", "webm", "mov", "gif"] as const).find((format) => format === value) ?? "mp4";
}

export function startConfiguredRender(
  onStartRender: StartRenderHandler,
  settings: PersistedRenderSettings & { resolution: ResolutionPreset | "auto"; gifLoop: number },
): void | Promise<void> {
  const { format, quality, resolution, fps, gpu, gifLoop } = settings;
  if (format === "gif") return onStartRender(format, quality, resolution, fps, false, gifLoop);
  return onStartRender(format, quality, resolution, fps, gpu);
}

export function isRenderExportBlocked(
  isRendering: boolean,
  missingFfmpeg: boolean,
  invalidGifLoop: boolean,
): boolean {
  return isRendering || missingFfmpeg || invalidGifLoop;
}

export const FORMAT_INFO: Record<"mp4" | "webm" | "mov" | "gif", { label: string; desc: string }> =
  {
    gif: { label: "GIF", desc: "Animated image for docs and chat. No audio; up to 30 fps." },
    mp4: { label: "MP4", desc: "Best for general use. Smallest file, universal playback." },
    mov: {
      label: "MOV (ProRes 4444)",
      desc: "Transparent video. Works in Final Cut Pro, DaVinci Resolve, and most video editors. Large files.",
    },
    webm: {
      label: "WebM (VP9)",
      desc: "Transparent video for web. Smaller than MOV but limited editor support.",
    },
  };
