import { existsSync } from "node:fs";
import { extname } from "node:path";
import {
  cropPackOutputPath,
  outputSizeForCrop,
  pixelRect,
  type PixelRect,
  type SafeFrame,
} from "@hyperframes/parsers/safe-frames";
import { extractVideoMetadata } from "./ffprobe.js";
import { isHdrColorSpace } from "./hdr.js";
import { formatFfmpegError, runFfmpeg } from "./runFfmpeg.js";
import { appendRenderProvenanceArgs } from "./renderProvenance.js";

export interface CropPackMemberPlan {
  id: string;
  crop: PixelRect;
  outputWidth: number;
  outputHeight: number;
  outputPath: string;
}

export interface CropPackMemberResult {
  id: string;
  outputPath: string;
  width: number;
  height: number;
}

/** The master's encoder settings, so siblings match its quality. */
export interface CropPackEncodeSettings {
  /** x264 preset for mp4, VP9 deadline for webm, ProRes profile for mov. */
  preset: string;
  /** CRF for mp4 and webm. */
  quality: number;
  /** Target bitrate; replaces CRF for mp4 and caps VP9 when set. */
  bitrate?: string;
}

export interface BuildCropPackArgsInput {
  masterPath: string;
  outputPath: string;
  crop: PixelRect;
  outputWidth: number;
  outputHeight: number;
  copyAudio: boolean;
  encode?: CropPackEncodeSettings;
}

export function planCropPackMembers(
  frames: SafeFrame[],
  compositionWidth: number,
  compositionHeight: number,
  masterPath: string,
): CropPackMemberPlan[] {
  return frames.map((frame) => {
    const crop = pixelRect(frame, compositionWidth, compositionHeight);
    const output = outputSizeForCrop(crop, frame.ratio);
    return {
      id: frame.id,
      crop,
      outputWidth: output.width,
      outputHeight: output.height,
      outputPath: cropPackOutputPath(masterPath, frame.id),
    };
  });
}

/**
 * Plans against the encoded master's probed size. With `--resolution` the
 * master is supersampled past the composition size, so composition pixels
 * would crop the wrong region.
 */
export async function planCropPackMembersForMaster(
  frames: SafeFrame[],
  compositionWidth: number,
  compositionHeight: number,
  masterPath: string,
): Promise<CropPackMemberPlan[]> {
  const metadata = await extractVideoMetadata(masterPath);
  const sized = metadata.width > 0 && metadata.height > 0;
  return planCropPackMembers(
    frames,
    sized ? metadata.width : compositionWidth,
    sized ? metadata.height : compositionHeight,
    masterPath,
  );
}

function videoEncodeArgs(outputPath: string, encode?: CropPackEncodeSettings): string[] {
  const ext = extname(outputPath).toLowerCase();
  if (ext === ".webm") {
    const rate = encode
      ? ["-b:v", encode.bitrate || "0", "-crf", String(encode.quality), "-deadline", encode.preset]
      : [];
    return ["-c:v", "libvpx-vp9", ...rate, "-pix_fmt", "yuv420p"];
  }
  if (ext === ".mov") {
    const profile = encode ? ["-profile:v", encode.preset] : [];
    return ["-c:v", "prores_ks", ...profile, "-pix_fmt", "yuva444p10le"];
  }
  const rate = encode
    ? [
        "-preset",
        encode.preset,
        ...(encode.bitrate ? ["-b:v", encode.bitrate] : ["-crf", String(encode.quality)]),
      ]
    : [];
  return ["-c:v", "libx264", ...rate, "-pix_fmt", "yuv420p"];
}

/**
 * ffmpeg argv for one crop-pack member. Video is crop+scale (re-encode);
 * audio is copied when requested. Provenance is re-applied; chapter
 * metadata is copied with `-map_metadata 0`. Never passes
 * `-avoid_negative_ts make_zero`.
 */
export function buildCropPackArgs(input: BuildCropPackArgsInput): string[] {
  const filter = `crop=${input.crop.width}:${input.crop.height}:${input.crop.x}:${input.crop.y},scale=${input.outputWidth}:${input.outputHeight}`;
  const args = [
    "-i",
    input.masterPath,
    "-filter:v",
    filter,
    ...videoEncodeArgs(input.outputPath, input.encode),
  ];
  args.push("-map", "0:v:0");
  if (input.copyAudio) {
    args.push("-map", "0:a?", "-c:a", "copy");
  } else {
    args.push("-an");
  }
  args.push("-map_metadata", "0");
  appendRenderProvenanceArgs(args, input.outputPath);
  args.push("-y", input.outputPath);
  return args;
}

export async function encodeCropPackMember(
  member: CropPackMemberPlan,
  masterPath: string,
  options: { copyAudio?: boolean; signal?: AbortSignal; encode?: CropPackEncodeSettings } = {},
): Promise<CropPackMemberResult> {
  if (!existsSync(masterPath)) {
    throw new Error(`Crop pack master "${masterPath}" does not exist.`);
  }
  const metadata = await extractVideoMetadata(masterPath);
  if (isHdrColorSpace(metadata.colorSpace)) {
    throw new Error(
      `Crop pack member "${member.id}" cannot be written: crop+scale would break HDR.`,
    );
  }
  const copyAudio = (options.copyAudio ?? true) && metadata.hasAudio;
  const args = buildCropPackArgs({
    masterPath,
    outputPath: member.outputPath,
    crop: member.crop,
    outputWidth: member.outputWidth,
    outputHeight: member.outputHeight,
    copyAudio,
    encode: options.encode,
  });
  const result = await runFfmpeg(args, { signal: options.signal });
  if (!result.success) {
    throw new Error(
      `Crop pack member "${member.id}" failed: ${formatFfmpegError(result.exitCode, result.stderr)}`,
    );
  }
  return {
    id: member.id,
    outputPath: member.outputPath,
    width: member.outputWidth,
    height: member.outputHeight,
  };
}

export { cropPackOutputPath };
