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

vi.mock("./hdr.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./hdr.js")>()),
  isHdrColorSpace: (cs: { colorTransfer?: string } | null) =>
    cs?.colorTransfer === "smpte2084" || cs?.colorTransfer === "arib-std-b67",
}));

import {
  buildCropPackArgs,
  encodeCropPackMember,
  planCropPackMembers,
  planCropPackMembersForMaster,
} from "./cropPack.js";

const fps = { num: 30, den: 1 };
const mp4Encode = {
  fps,
  codec: "h264" as const,
  preset: "medium",
  quality: 23,
  pixelFormat: "yuv420p",
};

describe("buildCropPackArgs", () => {
  const crop = { x: 656, y: 0, width: 608, height: 1080 };
  const base = {
    masterPath: "renders/launch.mp4",
    outputPath: "renders/launch.vertical.mp4",
    crop,
    outputWidth: 608,
    outputHeight: 1080,
    copyAudio: true,
  };
  const valueOf = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  it("crops in -filter:v without the master's range conversion", () => {
    const args = buildCropPackArgs({ ...base, encode: mp4Encode });
    expect(valueOf(args, "-filter:v")).toBe("crop=608:1080:656:0");
    expect(args).not.toContain("-vf");
    expect(valueOf(args, "-c:a")).toBe("copy");
    expect(args).toContain("-map_metadata");
    expect(args).not.toContain("-avoid_negative_ts");
    expect(args.slice(-2)).toEqual(["-y", "renders/launch.vertical.mp4"]);
  });

  it("omits audio copy when requested", () => {
    const args = buildCropPackArgs({ ...base, copyAudio: false, encode: mp4Encode });
    expect(args).toContain("-an");
    expect(args).not.toContain("-c:a");
  });

  it("encodes an mp4 sibling like the master: preset, CRF, no B-frames, BT.709 tags", () => {
    const args = buildCropPackArgs({
      ...base,
      encode: { ...mp4Encode, preset: "slow", quality: 18 },
    });
    expect(valueOf(args, "-c:v")).toBe("libx264");
    expect(valueOf(args, "-preset")).toBe("slow");
    expect(valueOf(args, "-crf")).toBe("18");
    expect(valueOf(args, "-bf")).toBe("0");
    expect(valueOf(args, "-color_primaries:v")).toBe("bt709");
    expect(valueOf(args, "-pix_fmt")).toBe("yuv420p");
  });

  it("uses the master's bitrate instead of CRF when one is set", () => {
    const args = buildCropPackArgs({ ...base, encode: { ...mp4Encode, bitrate: "10M" } });
    expect(valueOf(args, "-b:v")).toBe("10M");
    expect(args).not.toContain("-crf");
  });

  it("keeps alpha on a transparent webm sibling", () => {
    const args = buildCropPackArgs({
      ...base,
      masterPath: "renders/launch.webm",
      outputPath: "renders/launch.vertical.webm",
      encode: { fps, codec: "vp9", preset: "good", quality: 18, pixelFormat: "yuva420p" },
    });
    expect(args.slice(0, 3)).toEqual(["-c:v", "libvpx-vp9", "-i"]);
    expect(args[args.lastIndexOf("-c:v") + 1]).toBe("libvpx-vp9");
    expect(valueOf(args, "-pix_fmt")).toBe("yuva420p");
    expect(valueOf(args, "-metadata:s:v:0")).toBe("alpha_mode=1");
  });

  it("encodes an HDR sibling as 10-bit HEVC with the master's HDR tags", () => {
    const args = buildCropPackArgs({
      ...base,
      encode: {
        fps,
        codec: "h265",
        preset: "medium",
        quality: 23,
        pixelFormat: "yuv420p10le",
        hdr: { transfer: "pq" },
      },
    });
    expect(valueOf(args, "-c:v")).toBe("libx265");
    expect(valueOf(args, "-pix_fmt")).toBe("yuv420p10le");
    expect(valueOf(args, "-color_trc:v")).toBe("smpte2084");
    expect(valueOf(args, "-color_primaries:v")).toBe("bt2020");
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

  it("crops an odd rect straight to the even output size, without a resample", () => {
    const [member] = planCropPackMembers(
      [{ id: "square", ratio: "1:1", x: 0, y: 0, width: (0.123 * 1080) / 1920, height: 0.123 }],
      1920,
      1080,
      "renders/launch.mp4",
    );
    expect(member?.crop).toEqual({ x: 0, y: 0, width: 132, height: 132 });
    expect(member?.outputWidth).toBe(132);
    expect(member?.outputHeight).toBe(132);
    const args = buildCropPackArgs({
      masterPath: "renders/launch.mp4",
      outputPath: "renders/launch.square.mp4",
      crop: member!.crop,
      outputWidth: member!.outputWidth,
      outputHeight: member!.outputHeight,
      copyAudio: true,
      encode: mp4Encode,
    });
    expect(args[args.indexOf("-filter:v") + 1]).toBe("crop=132:132:0:0");
  });

  it("still scales when the output is smaller than the crop by 2px or more", () => {
    const args = buildCropPackArgs({
      masterPath: "renders/launch.mp4",
      outputPath: "renders/launch.vertical.mp4",
      crop: { x: 656, y: 0, width: 608, height: 1080 },
      outputWidth: 304,
      outputHeight: 540,
      copyAudio: true,
      encode: mp4Encode,
    });
    expect(args[args.indexOf("-filter:v") + 1]).toBe("crop=608:1080:656:0,scale=304:540");
  });

  it("falls back to the composition size when the probe fails", async () => {
    extractVideoMetadataMock.mockRejectedValue(new Error("ffprobe failed"));
    const members = await planCropPackMembersForMaster(
      [vertical],
      1920,
      1080,
      "renders/launch.mp4",
    );
    expect(members[0]?.crop).toEqual({ x: 656, y: 0, width: 608, height: 1080 });
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
        { encode: mp4Encode },
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
      { encode: mp4Encode },
    );
    expect(result.id).toBe("vertical");
    const args = runFfmpegMock.mock.calls[0]?.[0] as string[];
    expect(args[args.indexOf("-c:a") + 1]).toBe("copy");
  });

  it("hard-errors an HDR master without HDR encoder settings", async () => {
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
        { encode: mp4Encode },
      ),
    ).rejects.toThrow(/vertical[\s\S]*HDR/);
    expect(runFfmpegMock).not.toHaveBeenCalled();
  });

  it("encodes an HDR master when the master's HDR settings are passed", async () => {
    dir = mkdtempSync(join(tmpdir(), "hf-crop-hdr-"));
    const masterPath = join(dir, "launch.mp4");
    writeFileSync(masterPath, "fake");
    extractVideoMetadataMock.mockResolvedValue({
      hasAudio: false,
      colorSpace: { colorTransfer: "smpte2084", colorPrimaries: "bt2020", colorSpace: "bt2020nc" },
    });
    runFfmpegMock.mockResolvedValue({ success: true, exitCode: 0, stderr: "" });

    await encodeCropPackMember(
      {
        id: "vertical",
        crop: { x: 656, y: 0, width: 608, height: 1080 },
        outputWidth: 608,
        outputHeight: 1080,
        outputPath: join(dir, "launch.vertical.mp4"),
      },
      masterPath,
      {
        encode: {
          fps,
          codec: "h265",
          preset: "medium",
          quality: 23,
          pixelFormat: "yuv420p10le",
          hdr: { transfer: "pq" },
        },
      },
    );
    const args = runFfmpegMock.mock.calls[0]?.[0] as string[];
    expect(args[args.indexOf("-c:v") + 1]).toBe("libx265");
  });
});
