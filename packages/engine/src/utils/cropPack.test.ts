import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { runFfmpegMock, extractVideoMetadataMock } = vi.hoisted(() => ({
  runFfmpegMock: vi.fn(),
  extractVideoMetadataMock: vi.fn(),
}));

vi.mock("./runFfmpeg.js", () => ({
  runFfmpeg: runFfmpegMock,
  formatFfmpegError: (code: number | null, stderr: string) => `exit ${code}: ${stderr}`,
}));

vi.mock("./ffprobe.js", () => ({
  extractVideoMetadata: extractVideoMetadataMock,
}));

vi.mock("./hdr.js", () => ({
  isHdrColorSpace: (cs: { colorTransfer?: string } | null) =>
    cs?.colorTransfer === "smpte2084" || cs?.colorTransfer === "arib-std-b67",
}));

import {
  buildCropPackArgs,
  encodeCropPackMember,
  planCropPackMembers,
  planCropPackMembersForMaster,
} from "./cropPack.js";

describe("buildCropPackArgs", () => {
  const crop = { x: 656, y: 0, width: 608, height: 1080 };

  it("puts crop and scale numbers in -filter:v", () => {
    const args = buildCropPackArgs({
      masterPath: "renders/launch.mp4",
      outputPath: "renders/launch.vertical.mp4",
      crop,
      outputWidth: 608,
      outputHeight: 1080,
      copyAudio: true,
    });
    const vf = args[args.indexOf("-filter:v") + 1];
    expect(vf).toBe("crop=608:1080:656:0,scale=608:1080");
    expect(args).toContain("-c:a");
    expect(args[args.indexOf("-c:a") + 1]).toBe("copy");
    expect(args).toContain("-map_metadata");
    expect(args).not.toContain("make_zero");
    expect(args).not.toContain("-avoid_negative_ts");
  });

  it("omits audio copy when requested", () => {
    const args = buildCropPackArgs({
      masterPath: "renders/launch.mp4",
      outputPath: "renders/launch.vertical.mp4",
      crop,
      outputWidth: 608,
      outputHeight: 1080,
      copyAudio: false,
    });
    expect(args).toContain("-an");
    expect(args).not.toContain("-c:a");
  });

  it("encodes an mp4 sibling with the master's preset and CRF", () => {
    const args = buildCropPackArgs({
      masterPath: "renders/launch.mp4",
      outputPath: "renders/launch.vertical.mp4",
      crop,
      outputWidth: 608,
      outputHeight: 1080,
      copyAudio: true,
      encode: { preset: "slow", quality: 18 },
    });
    expect(args[args.indexOf("-preset") + 1]).toBe("slow");
    expect(args[args.indexOf("-crf") + 1]).toBe("18");
    expect(args).not.toContain("-b:v");
  });

  it("uses the master's bitrate instead of CRF when one is set", () => {
    const args = buildCropPackArgs({
      masterPath: "renders/launch.mp4",
      outputPath: "renders/launch.vertical.mp4",
      crop,
      outputWidth: 608,
      outputHeight: 1080,
      copyAudio: true,
      encode: { preset: "medium", quality: 23, bitrate: "10M" },
    });
    expect(args[args.indexOf("-b:v") + 1]).toBe("10M");
    expect(args).not.toContain("-crf");
  });

  it("encodes a webm sibling in VP9 constant-quality mode", () => {
    const args = buildCropPackArgs({
      masterPath: "renders/launch.webm",
      outputPath: "renders/launch.vertical.webm",
      crop,
      outputWidth: 608,
      outputHeight: 1080,
      copyAudio: true,
      encode: { preset: "good", quality: 18 },
    });
    expect(args[args.indexOf("-c:v") + 1]).toBe("libvpx-vp9");
    expect(args[args.indexOf("-b:v") + 1]).toBe("0");
    expect(args[args.indexOf("-crf") + 1]).toBe("18");
    expect(args[args.indexOf("-deadline") + 1]).toBe("good");
  });
});

describe("planCropPackMembers", () => {
  it("names sibling files and uses snapped pixel rects", () => {
    const members = planCropPackMembers(
      [
        {
          id: "vertical",
          ratio: "9:16",
          x: (1920 - 608) / 2 / 1920,
          y: 0,
          width: 608 / 1920,
          height: 1,
        },
      ],
      1920,
      1080,
      "renders/launch.mp4",
    );
    expect(members[0]).toMatchObject({
      id: "vertical",
      outputPath: "renders/launch.vertical.mp4",
      outputWidth: 608,
      outputHeight: 1080,
      crop: { x: 656, y: 0, width: 608, height: 1080 },
    });
  });
});

describe("planCropPackMembersForMaster", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  const vertical = {
    id: "vertical",
    ratio: "9:16" as const,
    x: (1920 - 608) / 2 / 1920,
    y: 0,
    width: 608 / 1920,
    height: 1,
  };

  it("crops the supersampled master at its probed size", async () => {
    extractVideoMetadataMock.mockResolvedValue({ width: 3840, height: 2160 });
    const members = await planCropPackMembersForMaster(
      [vertical],
      1920,
      1080,
      "renders/launch.mp4",
    );
    expect(extractVideoMetadataMock).toHaveBeenCalledWith("renders/launch.mp4");
    expect(members[0]?.crop).toEqual(planCropPackMembers([vertical], 3840, 2160, "x.mp4")[0]?.crop);
    expect(members[0]?.crop.x).toBe(1312);
    expect(members[0]?.crop.height).toBe(2160);
    expect(members[0]?.outputHeight).toBe(2160);
  });

  it("falls back to the composition size when the probe has no dimensions", async () => {
    extractVideoMetadataMock.mockResolvedValue({ width: 0, height: 0 });
    const members = await planCropPackMembersForMaster(
      [vertical],
      1920,
      1080,
      "renders/launch.mp4",
    );
    expect(members[0]?.crop).toEqual({ x: 656, y: 0, width: 608, height: 1080 });
  });
});

describe("encodeCropPackMember", () => {
  let dir: string;

  afterEach(() => {
    vi.clearAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("fails when the master file is missing", async () => {
    await expect(
      encodeCropPackMember(
        {
          id: "vertical",
          crop: { x: 0, y: 0, width: 608, height: 1080 },
          outputWidth: 608,
          outputHeight: 1080,
          outputPath: "renders/launch.vertical.mp4",
        },
        "/no/such/master.mp4",
      ),
    ).rejects.toThrow(/does not exist/);
    expect(runFfmpegMock).not.toHaveBeenCalled();
  });

  it("copies audio on an SDR master", async () => {
    dir = mkdtempSync(join(tmpdir(), "hf-crop-"));
    const masterPath = join(dir, "launch.mp4");
    writeFileSync(masterPath, "fake");
    mkdirSync(join(dir, "out"), { recursive: true });
    extractVideoMetadataMock.mockResolvedValue({
      hasAudio: true,
      colorSpace: { colorTransfer: "bt709", colorPrimaries: "bt709", colorSpace: "bt709" },
    });
    runFfmpegMock.mockResolvedValue({ success: true, exitCode: 0, stderr: "" });

    const result = await encodeCropPackMember(
      {
        id: "vertical",
        crop: { x: 656, y: 0, width: 608, height: 1080 },
        outputWidth: 608,
        outputHeight: 1080,
        outputPath: join(dir, "launch.vertical.mp4"),
      },
      masterPath,
    );
    expect(result.id).toBe("vertical");
    const args = runFfmpegMock.mock.calls[0]?.[0] as string[];
    expect(args[args.indexOf("-c:a") + 1]).toBe("copy");
  });

  it("hard-errors an HDR master instead of writing SDR", async () => {
    dir = mkdtempSync(join(tmpdir(), "hf-crop-hdr-"));
    const masterPath = join(dir, "launch.mp4");
    writeFileSync(masterPath, "fake");
    extractVideoMetadataMock.mockResolvedValue({
      hasAudio: true,
      colorSpace: { colorTransfer: "smpte2084", colorPrimaries: "bt2020", colorSpace: "bt2020nc" },
    });

    await expect(
      encodeCropPackMember(
        {
          id: "vertical",
          crop: { x: 656, y: 0, width: 608, height: 1080 },
          outputWidth: 608,
          outputHeight: 1080,
          outputPath: join(dir, "launch.vertical.mp4"),
        },
        masterPath,
      ),
    ).rejects.toThrow(/vertical[\s\S]*HDR/);
    expect(runFfmpegMock).not.toHaveBeenCalled();
  });
});
