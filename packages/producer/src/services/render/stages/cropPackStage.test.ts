import { beforeEach, describe, expect, it, vi } from "vitest";

const { encodeCropPackMemberMock, planCropPackMembersForMasterMock } = vi.hoisted(() => ({
  encodeCropPackMemberMock: vi.fn(),
  planCropPackMembersForMasterMock: vi.fn(),
}));

vi.mock("@hyperframes/engine", () => ({
  encodeCropPackMember: encodeCropPackMemberMock,
  planCropPackMembersForMaster: planCropPackMembersForMasterMock,
}));

import { runCropPackStage } from "./cropPackStage.js";
import type { RenderJob } from "../../renderOrchestrator.js";

const encode = {
  fps: { num: 30, den: 1 },
  codec: "h264" as const,
  preset: "slow",
  quality: 18,
  pixelFormat: "yuv420p",
};

function makeJob(overrides: Partial<RenderJob["config"]> = {}): RenderJob {
  return {
    id: "crop-pack",
    config: {
      fps: { num: 30, den: 1 },
      quality: "draft",
      cropPack: {
        compositionWidth: 1920,
        compositionHeight: 1080,
        members: [
          {
            id: "vertical",
            ratio: "9:16",
            x: (1920 - 608) / 2 / 1920,
            y: 0,
            width: 608 / 1920,
            height: 1,
          },
        ],
      },
      ...overrides,
    },
    status: "queued",
    progress: 0,
    currentStage: "queued",
    createdAt: new Date(0),
  };
}

describe("runCropPackStage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    planCropPackMembersForMasterMock.mockResolvedValue([
      {
        id: "vertical",
        crop: { x: 656, y: 0, width: 608, height: 1080 },
        outputWidth: 608,
        outputHeight: 1080,
        outputPath: "/tmp/launch.vertical.mp4",
      },
    ]);
    encodeCropPackMemberMock.mockResolvedValue({
      id: "vertical",
      outputPath: "/tmp/launch.vertical.mp4",
      width: 608,
      height: 1080,
    });
  });

  it("leaves the master path unchanged and writes sibling names", async () => {
    const job = makeJob();
    const masterPath = "/tmp/launch.mp4";
    const result = await runCropPackStage({ job, masterPath, format: "mp4", encode });
    expect(masterPath).toBe("/tmp/launch.mp4");
    expect(result.members[0]?.outputPath).toBe("/tmp/launch.vertical.mp4");
    expect(job.cropPack?.[0]?.outputPath).toBe("/tmp/launch.vertical.mp4");
    expect(planCropPackMembersForMasterMock).toHaveBeenCalledWith(
      job.config.cropPack?.members,
      1920,
      1080,
      masterPath,
    );
  });

  it("passes the master's encoder settings to every member", async () => {
    const job = makeJob();
    await runCropPackStage({ job, masterPath: "/tmp/launch.mp4", format: "mp4", encode });
    expect(encodeCropPackMemberMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "vertical" }),
      "/tmp/launch.mp4",
      expect.objectContaining({ encode }),
    );
  });

  it("skips an empty pack list", async () => {
    const job = makeJob({ cropPack: undefined });
    const result = await runCropPackStage({
      job,
      masterPath: "/tmp/launch.mp4",
      format: "mp4",
      encode,
    });
    expect(result.members).toEqual([]);
    expect(encodeCropPackMemberMock).not.toHaveBeenCalled();
  });

  it("skips gif and png-sequence", async () => {
    const job = makeJob();
    await runCropPackStage({ job, masterPath: "/tmp/launch.gif", format: "gif", encode });
    await runCropPackStage({ job, masterPath: "/tmp/frames", format: "png-sequence", encode });
    expect(encodeCropPackMemberMock).not.toHaveBeenCalled();
  });
});
