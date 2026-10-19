/**
 * What a chunk worker's capture session is built from (capture options, video
 * frames and their injector), shared with the planner's frame-cost measurement.
 */
import { existsSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import {
  type BeforeCaptureHook,
  BROWSER_GPU_NOT_SOFTWARE,
  compositionRequiresWebGpu,
  type CaptureOptions,
  createFrameLookupTable,
  createVideoFrameInjector,
  type EngineConfig,
  type ExtractedFrames,
  extractVideoFramesRange,
  type FrameRange,
  type FrameLookupTable,
} from "@hyperframes/engine";
import { resolveVideoCaptureBeyondViewport } from "../render/captureBeyondViewport.js";
import { resolveCaptureJpegQuality } from "../render/captureImageFormat.js";
import type { LockedRenderConfig } from "../render/stages/freezePlan.js";
import { resolveRenderFpsConfig } from "../fileServer.js";
import { type DistributedFormat, INVALID_VIDEO_METADATA, type PlanVideosJson } from "./shared.js";

/**
 * Non-retryable error codes raised when the planDir is structurally
 * malformed, semantically out of range, or fingerprints differently from
 * what the controller wrote. Each is distinct so adapter retry policies
 * can route them independently — e.g. `MISSING_PLAN_ARTIFACT` may point
 * to a partial S3 download that a retry could heal, while
 * `PLAN_HASH_MISMATCH` strictly indicates cross-version drift that
 * retries won't fix.
 */
export const FFMPEG_VERSION_MISMATCH = "FFMPEG_VERSION_MISMATCH";
export const PLAN_HASH_MISMATCH = "PLAN_HASH_MISMATCH";
export const MISSING_PLAN_ARTIFACT = "MISSING_PLAN_ARTIFACT";
export const CHUNK_INDEX_OUT_OF_RANGE = "CHUNK_INDEX_OUT_OF_RANGE";
export const MISSING_RUNTIME_ENV_SNAPSHOT = "MISSING_RUNTIME_ENV_SNAPSHOT";
export { INVALID_VIDEO_METADATA };

export type RenderChunkValidationCode =
  | typeof FFMPEG_VERSION_MISMATCH
  | typeof PLAN_HASH_MISMATCH
  | typeof MISSING_PLAN_ARTIFACT
  | typeof CHUNK_INDEX_OUT_OF_RANGE
  | typeof MISSING_RUNTIME_ENV_SNAPSHOT
  | typeof INVALID_VIDEO_METADATA
  | typeof BROWSER_GPU_NOT_SOFTWARE;

/**
 * Typed non-retryable error raised by `renderChunk` when the planDir is
 * malformed or the worker's runtime doesn't match the planDir's
 * controller-side fingerprint. Workflow adapters key retry policies off
 * `code` — most of these failures will not heal on retry.
 */
export class RenderChunkValidationError extends Error {
  readonly code: RenderChunkValidationCode;
  constructor(code: RenderChunkValidationCode, message: string) {
    super(message);
    this.name = "RenderChunkValidationError";
    this.code = code;
  }
}

/**
 * Build the immutable lookup table once, but keep injector state scoped to a
 * browser session. Reusing one hook across workers or a whole-chunk retry can
 * incorrectly suppress injection on a fresh page.
 */
export function createChunkVideoFrameInjectorFactory(
  frameLookup: FrameLookupTable | null,
): () => BeforeCaptureHook | null {
  return () => createVideoFrameInjector(frameLookup);
}

function frameNumberFromFileName(name: string): number | null {
  const match = /(\d+)(?=\.[^.]+$)/.exec(name);
  if (!match) return null;
  const frameNumber = Number(match[1]);
  return Number.isSafeInteger(frameNumber) ? frameNumber : null;
}

/**
 * Rebuild the engine's in-memory `ExtractedFrames[]` from the on-disk
 * planDir layout. `<planDir>/video-frames/<videoId>/` holds the numbered
 * frame files plan() extracted; this lists each dir and rebuilds the
 * 0-based `framePaths` Map that `FrameLookupTable` / `videoFrameInjector`
 * both index against — the consumer is
 * `videoFrameExtractor.ts:getFrameAtTime`, which floors `localTime * fps`
 * to a 0-based index and reads `framePaths.get(frameIndex)`. Any drift
 * from that key convention silently drops every `<video>`'s first-paint
 * frame; see HF#1731 / HF#1730.
 *
 * Exported so a unit test can pin the 0-based contract without spinning
 * up the heavyweight Docker fixture — the bug surfaces only under
 * distributed mode and only at video first-paint, so this primitive is
 * the right granularity to guard.
 */
export function rebuildExtractedFramesFromPlanDir(
  planDir: string,
  videos: PlanVideosJson["extracted"],
  indexMode: "dense-v1" | "sparse-v2" = "dense-v1",
): ExtractedFrames[] {
  const result: ExtractedFrames[] = [];
  for (const v of videos) {
    const outputDir = join(planDir, "video-frames", v.videoId);
    if (!existsSync(outputDir)) {
      throw new Error(
        `[renderChunk] planDir missing extracted video frames for ${JSON.stringify(v.videoId)}: ` +
          `${outputDir} not present. plan() should have written frames here; the planDir is malformed.`,
      );
    }
    // framePattern looks like `frame_%05d.jpg`; sprintf isn't available at
    // runtime so list the directory and order numeric names by their ordinal.
    // Width changes once FFmpeg passes the padding minimum, so lexical order
    // would interleave frame_100000 before frame_10001.
    const ext = (extname(v.framePattern) || ".jpg").toLowerCase();
    const frames = readdirSync(outputDir)
      .filter((name) => name.toLowerCase().endsWith(ext))
      .sort((left, right) => {
        const leftNumber = frameNumberFromFileName(left);
        const rightNumber = frameNumberFromFileName(right);
        if (leftNumber === null || rightNumber === null) return left.localeCompare(right);
        return leftNumber - rightNumber || left.localeCompare(right);
      });
    const framePaths = new Map<number, string>();
    for (let i = 0; i < frames.length; i++) {
      const frameName = frames[i];
      if (!frameName) continue;
      // V1 plans preserve the historical sorted-position behavior even for
      // unusual zero-based filenames. V2 materialization is sparse, so only
      // that mode derives the original index from ffmpeg's 1-based filename.
      const frameNumber = indexMode === "sparse-v2" ? frameNumberFromFileName(frameName) : null;
      const frameIndex = frameNumber === null ? i : frameNumber - 1;
      framePaths.set(frameIndex, join(outputDir, frameName));
    }
    result.push({
      videoId: v.videoId,
      srcPath: v.srcPath,
      outputDir,
      framePattern: v.framePattern,
      fps: v.fps,
      totalFrames: v.totalFrames,
      metadata: v.metadata,
      framePaths,
      // The chunk worker doesn't own the planDir's video-frames/ directory
      // (the controller does — adapters that fan out chunks across machines
      // share the planDir as read-only). Mark ownership as false so the
      // injector's eventual cleanup doesn't rm bytes another worker may
      // still be reading.
      ownedByLookup: false,
    });
  }
  return result;
}

function contiguousRuns(sortedIndexes: readonly number[]): FrameRange[] {
  const runs: FrameRange[] = [];
  for (const index of sortedIndexes) {
    const last = runs[runs.length - 1];
    if (last && last.firstFrame + last.frames === index) last.frames++;
    else runs.push({ firstFrame: index, frames: 1 });
  }
  return runs;
}

/** Capture options a chunk session uses; the planner measures frame cost with the same ones. */
export function buildChunkCaptureOptions(input: {
  dimensions: {
    width: number;
    height: number;
    fpsNum: number;
    fpsDen: number;
    format: DistributedFormat;
  };
  encoder: Pick<LockedRenderConfig, "quality" | "deviceScaleFactor" | "variables">;
  videoCount: number;
  html: string;
}): CaptureOptions {
  const { dimensions, encoder } = input;
  const videoCaptureBeyondViewport = resolveVideoCaptureBeyondViewport(input.videoCount);
  return {
    width: dimensions.width,
    height: dimensions.height,
    fps: { num: dimensions.fpsNum, den: dimensions.fpsDen },
    format: dimensions.format === "mp4" ? "jpeg" : "png",
    quality: dimensions.format === "mp4" ? resolveCaptureJpegQuality(encoder.quality) : undefined,
    deviceScaleFactor: encoder.deviceScaleFactor,
    // Re-inject the controller's snapshotted variables so the chunk's
    // first capture sees the same `window.__hfVariables` the in-process
    // renderer would have seen. Optional — compositions that don't
    // declare `data-composition-variables` leave this undefined and the
    // engine skips the `evaluateOnNewDocument` injection.
    variables: encoder.variables,
    subTimelineWaitMemo: {},
    ...(videoCaptureBeyondViewport !== undefined
      ? { captureBeyondViewport: videoCaptureBeyondViewport }
      : {}),
    // lock the BeginFrame warmup loop to a fixed iteration count so
    // `beginFrameTimeTicks` is host-independent. Only chunks ever set this.
    lockWarmupTicks: true,
    requiresWebGpu: compositionRequiresWebGpu(input.html),
  };
}

/**
 * Extract the given composition frames from videos the planner left
 * unextracted. Frames land in `outputRoot/<videoId>/` under the names a full
 * extraction gives them, so the lookup indexes them exactly as it would
 * frames the planner wrote.
 */
export async function extractDeferredVideoFramesForChunk(input: {
  planDir: string;
  planVideos: PlanVideosJson;
  frames: Iterable<number>;
  fps: { num: number; den: number };
  outputRoot: string;
  cfg: Pick<EngineConfig, "ffmpegProcessTimeout">;
}): Promise<ExtractedFrames[]> {
  const deferred = input.planVideos.extracted.filter((video) => video.deferredRange);
  if (deferred.length === 0) return [];
  const table = createFrameLookupTable(
    input.planVideos.videos,
    deferred.map((video) => ({
      ...video,
      outputDir: input.outputRoot,
      framePaths: new Map(Array.from({ length: video.totalFrames }, (_, i) => [i, String(i)])),
    })),
    resolveRenderFpsConfig(input.fps).value,
  );
  const shown = new Map<string, Set<number>>();
  for (const frame of input.frames) {
    const globalTime = (frame * input.fps.den) / input.fps.num;
    for (const [videoId, payload] of table.getActiveFramePayloads(globalTime)) {
      const indexes = shown.get(videoId) ?? new Set<number>();
      indexes.add(payload.frameIndex);
      shown.set(videoId, indexes);
    }
  }
  return Promise.all(
    deferred.map(async (video) => {
      const outputDir = join(input.outputRoot, video.videoId);
      const indexes = [...(shown.get(video.videoId) ?? [])].sort((a, b) => a - b);
      if (indexes.length === 0) {
        return { ...video, outputDir, framePaths: new Map<number, string>(), ownedByLookup: false };
      }
      const range = video.deferredRange!;
      const sourcePath = join(input.planDir, ...range.sourcePath.split("/"));
      if (!existsSync(sourcePath)) {
        throw new RenderChunkValidationError(
          MISSING_PLAN_ARTIFACT,
          `[renderChunk] planDir is missing the source for video ${JSON.stringify(video.videoId)}: ${range.sourcePath}`,
        );
      }
      const extracted = await extractVideoFramesRange(
        sourcePath,
        video.videoId,
        range.startTime,
        range.durationSeconds,
        {
          fps: input.fps,
          outputDir: input.outputRoot,
          format: range.format,
          frameRanges: contiguousRuns(indexes),
        },
        undefined,
        input.cfg,
      );
      const missing = indexes.find((index) => !extracted.framePaths.has(index));
      if (missing !== undefined) {
        throw new RenderChunkValidationError(
          INVALID_VIDEO_METADATA,
          `[renderChunk] video ${JSON.stringify(video.videoId)} has no frame ${missing}; ` +
            `the plan expected ${video.totalFrames} frames from ${range.sourcePath}.`,
        );
      }
      return { ...video, outputDir, framePaths: extracted.framePaths, ownedByLookup: false };
    }),
  );
}
