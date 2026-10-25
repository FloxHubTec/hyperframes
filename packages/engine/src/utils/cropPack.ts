import { existsSync } from "node:fs";
import {
  cropPackOutputPath,
  outputSizeForCrop,
  pixelRect,
  type PixelRect,
  type SafeFrame,
} from "@hyperframes/parsers/safe-frames";
import { buildEncoderArgs } from "../services/chunkEncoder.js";
import type { EncoderOptions } from "../services/chunkEncoder.types.js";
import { extractVideoMetadata } from "./ffprobe.js";
import { isHdrColorSpace } from "./hdr.js";
import { formatFfmpegError, runFfmpeg } from "./runFfmpeg.js";

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

/**
 * The master's encoder options. Siblings are encoded with `buildEncoderArgs`
 * so they keep the master's codec, pixel format, B-frame and color settings.
 */
export type CropPackEncodeSettings = Omit<
  EncoderOptions,
  "width" | "height" | "useGpu" | "lockGopForChunkConcat" | "gopSize"
>;

export interface BuildCropPackArgsInput {
  masterPath: string;
  outputPath: string;
  crop: PixelRect;
  outputWidth: number;
  outputHeight: number;
  copyAudio: boolean;
  encode: CropPackEncodeSettings;
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

function withoutOption(args: string[], flag: string): string[] {
  const i = args.indexOf(flag);
  return i === -1 ? args : [...args.slice(0, i), ...args.slice(i + 2)];
}

/** ffmpeg's native VP9 decoder drops the alpha plane; libvpx keeps it. */
function alphaDecoderArgs(encode: CropPackEncodeSettings): string[] {
  return encode.codec === "vp9" && encode.pixelFormat === "yuva420p" ? ["-c:v", "libvpx-vp9"] : [];
}

/**
 * ffmpeg argv for one crop-pack member: crop+scale re-encoded with the
 * master's encoder args. The master's `-vf` range conversion is dropped since
 * the master is already TV range, and so is `-avoid_negative_ts make_zero`.
 * Audio is copied when requested; chapter metadata via `-map_metadata 0`.
 */
export function buildCropPackArgs(input: BuildCropPackArgsInput): string[] {
  const filter = `crop=${input.crop.width}:${input.crop.height}:${input.crop.x}:${input.crop.y},scale=${input.outputWidth}:${input.outputHeight}`;
  let args = buildEncoderArgs(
    { ...input.encode, width: input.outputWidth, height: input.outputHeight, useGpu: false },
    [...alphaDecoderArgs(input.encode), "-i", input.masterPath, "-filter:v", filter],
    input.outputPath,
  );
  args = withoutOption(withoutOption(args, "-vf"), "-avoid_negative_ts");
  const tail = args.splice(args.length - 2, 2);
  args.push("-map", "0:v:0");
  if (input.copyAudio) {
    args.push("-map", "0:a?", "-c:a", "copy");
  } else {
    args.push("-an");
  }
  args.push("-map_metadata", "0", ...tail);
  return args;
}

export async function encodeCropPackMember(
  member: CropPackMemberPlan,
  masterPath: string,
  options: { copyAudio?: boolean; signal?: AbortSignal; encode: CropPackEncodeSettings },
): Promise<CropPackMemberResult> {
  if (!existsSync(masterPath)) {
    throw new Error(`Crop pack master "${masterPath}" does not exist.`);
  }
  const metadata = await extractVideoMetadata(masterPath);
  if (isHdrColorSpace(metadata.colorSpace) && !options.encode.hdr) {
    throw new Error(
      `Crop pack member "${member.id}" cannot be written: HDR master without HDR encoder settings.`,
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
