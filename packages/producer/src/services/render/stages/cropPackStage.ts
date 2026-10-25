/**
 * cropPackStage — post-assemble local crops of the encoded master.
 *
 * One capture, several sibling files. GIF and png-sequence skip (no muxed
 * master to crop). An empty pack list is a no-op. Any member failure fails
 * the job; the master `outputPath` stays the assemble result.
 */

import {
  encodeCropPackMember,
  planCropPackMembersForMaster,
  type CropPackEncodeSettings,
  type CropPackMemberResult,
} from "@hyperframes/engine";
import type { RenderJob } from "../../renderOrchestrator.js";

export interface CropPackStageInput {
  job: RenderJob;
  masterPath: string;
  format: string;
  /** The master's encoder options, so siblings match its encode. */
  encode: CropPackEncodeSettings;
  abortSignal?: AbortSignal;
}

export interface CropPackStageResult {
  members: CropPackMemberResult[];
}

function isCropPackContainer(format: string): boolean {
  return format === "mp4" || format === "mov" || format === "webm";
}

export async function runCropPackStage(input: CropPackStageInput): Promise<CropPackStageResult> {
  const spec = input.job.config.cropPack;
  if (!spec || spec.members.length === 0) return { members: [] };
  if (!isCropPackContainer(input.format)) return { members: [] };

  const plans = await planCropPackMembersForMaster(
    spec.members,
    spec.compositionWidth,
    spec.compositionHeight,
    input.masterPath,
  );
  const members: CropPackMemberResult[] = [];
  for (const plan of plans) {
    members.push(
      await encodeCropPackMember(plan, input.masterPath, {
        copyAudio: true,
        signal: input.abortSignal,
        encode: input.encode,
      }),
    );
  }
  input.job.cropPack = members;
  return { members };
}
