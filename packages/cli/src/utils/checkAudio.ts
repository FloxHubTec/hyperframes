import { existsSync } from "node:fs";
import { parseHTML } from "linkedom";
import { normalizeRateSpec, sourceTimeAt } from "@hyperframes/core";
import { silence } from "@hyperframes/core/audio-analysis";
import {
  extractAudioMetadata,
  extractMediaMetadata,
  type AudioElement,
  type AudioMetadata,
} from "@hyperframes/engine";
import { decodeAudio } from "../audio/analysis/decode.js";
import { createProbeGate } from "../timeline/describeProject.js";
import { findingAtRoot } from "./checkFindings.js";
import type { CheckFinding } from "./checkTypes.js";
import { mediaPath, type ProjectMedia } from "./projectMedia.js";

export interface AudioCheckDependencies {
  probeAudio(path: string): Promise<AudioMetadata>;
  videoHasAudio(path: string): Promise<boolean>;
  /** Whether `seconds` of the file from `from` are silent all through. */
  isSilent(path: string, from: number, seconds: number, probed: AudioMetadata): Promise<boolean>;
}

/** Silence is a level question: a low mono rate decodes fast and keeps it. */
const SILENCE_SAMPLE_RATE = 8_000;
/** The silence measure's last analysis window can stop short of the decoded end. */
const EDGE_SECONDS = 0.02;
const PROBE_CONCURRENCY = 4;

const DEFAULT_DEPENDENCIES: AudioCheckDependencies = {
  probeAudio: (path) => extractAudioMetadata(path),
  videoHasAudio: async (path) => (await extractMediaMetadata(path)).hasAudio,
  async isSilent(path, from, seconds, probed) {
    const decoded = await decodeAudio(
      path,
      { from, seconds },
      {
        sampleRate: probed.sampleRate,
        channels: probed.channels,
        duration: probed.durationSeconds,
      },
      { mono: true, sampleRate: SILENCE_SAMPLE_RATE },
    );
    const samples = decoded?.signal.channels[0]?.length ?? 0;
    if (!decoded || samples === 0) return true;
    const [quiet, ...rest] = silence(decoded.signal);
    return (
      !!quiet &&
      rest.length === 0 &&
      quiet.start === 0 &&
      quiet.end >= samples / SILENCE_SAMPLE_RATE - EDGE_SECONDS
    );
  },
};

/** Findings for the clips the render mixes: unreadable source, start past the file's end, silent
 * played part; or a film with no sound at all. */
export async function inspectAudio(
  projectDir: string,
  sourceFile: string,
  media: ProjectMedia,
  dependencies: AudioCheckDependencies = DEFAULT_DEPENDENCIES,
): Promise<CheckFinding[]> {
  const withSlot = createProbeGate(PROBE_CONCURRENCY);
  // Parsed only for a clip with a finding, to name the composition file it was written in.
  let bundled: Document | undefined;
  const fileOf = (id: string) => {
    bundled ??= parseHTML(media.html).document;
    const host = bundled.getElementById(id)?.closest("[data-composition-file]");
    return host?.getAttribute("data-composition-file") || sourceFile;
  };
  const findings = await Promise.all(
    media.audios.map((clip) => withSlot(() => inspectClip(projectDir, fileOf, clip, dependencies))),
  );
  if (
    media.audios.length === 0 &&
    !(await videoSoundsAutoDetected(projectDir, media, dependencies))
  )
    return [
      findingAtRoot(
        "audio_none",
        "info",
        "The film has no sound: no clip in it plays audio.",
        sourceFile,
      ),
    ];
  return findings.flat();
}

/** Render adds an unmuted video's own sound when its file has an audio stream. */
async function videoSoundsAutoDetected(
  projectDir: string,
  media: ProjectMedia,
  dependencies: AudioCheckDependencies,
): Promise<boolean> {
  for (const video of media.videos) {
    if (!video.hasAudio) continue;
    if (await dependencies.videoHasAudio(mediaPath(video.src, projectDir)).catch(() => false))
      return true;
  }
  return false;
}

type ClipProblem = Pick<CheckFinding, "code" | "severity" | "message" | "fixHint">;

async function inspectClip(
  projectDir: string,
  fileOf: (id: string) => string,
  clip: AudioElement,
  dependencies: AudioCheckDependencies,
): Promise<CheckFinding[]> {
  const path = mediaPath(clip.src, projectDir);
  // ponytail: remote sources are not fetched; missing local files are lint's audio_src_not_found.
  if (path === clip.src || !existsSync(path)) return [];
  const problem = await clipProblem(path, clip, dependencies);
  if (!problem) return [];
  const id = clip.type === "video" ? clip.id.replace(/-audio$/, "") : clip.id;
  const played: Partial<CheckFinding> =
    clip.end > clip.start ? { timeRange: [clip.start, clip.end] } : {};
  return [
    {
      ...findingAtRoot(problem.code, problem.severity, problem.message, fileOf(id)),
      selector: `#${id}`,
      time: clip.start,
      ...played,
      fixHint: problem.fixHint,
    },
  ];
}

async function clipProblem(
  path: string,
  clip: AudioElement,
  dependencies: AudioCheckDependencies,
): Promise<ClipProblem | null> {
  let probed: AudioMetadata;
  try {
    probed = await dependencies.probeAudio(path);
  } catch (error) {
    return unreadable(clip, error);
  }
  const fileSeconds = probed.durationSeconds;
  if (clip.mediaStart >= fileSeconds) {
    return {
      code: "audio_starts_past_source_end",
      severity: "warning",
      message: `${clip.src} is ${round(fileSeconds)} s long but the clip starts ${round(clip.mediaStart)} s into it, so it plays nothing.`,
      fixHint: "Lower data-media-start below the file's length.",
    };
  }
  const from = clip.mediaStart;
  const seconds = Math.min(playedSourceSeconds(clip), fileSeconds - from);
  if (!(await dependencies.isSilent(path, from, seconds, probed))) return null;
  return {
    code: "audio_clip_silent",
    severity: "warning",
    message: `${clip.src} is silent for the whole part this clip plays (${round(from)}-${round(from + seconds)} s of the file).`,
    fixHint: "Check the file has sound there, or move data-media-start to where it does.",
  };
}

function unreadable(clip: AudioElement, error: unknown): ClipProblem {
  return {
    code: "audio_source_unreadable",
    severity: "error",
    message: `${clip.src} has no audio the render can read (${error instanceof Error ? error.message : String(error)}). The render's audio mix fails and the film ships without sound.`,
    fixHint:
      clip.type === "video"
        ? 'Remove data-has-audio="true" from the video, or point it at a file with an audio track.'
        : "Point src at an audio file, or re-export this one.",
  };
}

/** Seconds of its file a clip plays; unbounded clips play to the end of the file. */
function playedSourceSeconds(clip: AudioElement): number {
  if (clip.end <= clip.start) return Infinity;
  return sourceTimeAt(normalizeRateSpec(clip.playbackRate), clip.end - clip.start);
}

const round = (seconds: number) => Math.round(seconds * 100) / 100;
