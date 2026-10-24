import { describe, expect, it } from "vitest";
import { tailFramesFromFinalFrame } from "./videoFrameExtractor.js";

// Every expected count was read off a real tail extraction (frameRanges over the last
// `tailFrames` slots) of a generated H.264 or ProRes source whose last frame starts at `final`.
const MEASURED: [
  start: number,
  firstFrame: number,
  tailFrames: number,
  outputFps: number,
  sourceFps: number,
  final: number,
  expected: number | null,
][] = [
  // the window ends past the source: every slot holds a frame
  [0.097041, 34, 60, 60, 60, 2.05, 60],
  [0.75, 62, 24, 24, 23.98, 5.130125, 24],
  [1.458333, 15, 24, 24, 29.97, 4.1041, 24],
  // the source ends inside the tail
  [0.68, 13, 25, 25, 60, 2.05, 22],
  [1.17348, 74, 24, 24, 24, 5.125, 22],
  [1.387047, 68, 24, 24, 23.98, 5.130125, 23],
  [1.221575, 92, 30, 30, 23.98, 5.130125, 27],
  [0.27924, 70, 24, 24000 / 1001, 29.97, 4.1041, 23],
  // a slot exactly on the source's end is empty
  [0.133333, 234, 60, 60, 30, 4.966667, 58],
  [1.4, 66, 25, 25, 30, 4.966667, 24],
  [0.291667, 120, 24, 24, 24, 6.208333, 23],
  [0.959292, 76, 24, 24000 / 1001, 29.97, 4.971633, 21],
  [1.3013, 82, 30, 30000 / 1001, 29.97, 4.971633, 29],
  // a slot a few microseconds from the end: ffmpeg decides, so decode instead
  [1.359997, 44, 30, 30, 25, 4.92, null],
  [0.983337, 58, 60, 60, 30, 3, null],
];

describe("tailFramesFromFinalFrame", () => {
  it.each(MEASURED)(
    "start %d, first %d: %d slots at %d fps over a %d fps source ending %d",
    (startTime, firstFrame, tailFrames, outputFps, sourceFps, finalFrameSeconds, expected) => {
      expect(
        tailFramesFromFinalFrame({
          startTime,
          firstFrame,
          tailFrames,
          outputFps,
          sourceFps,
          finalFrameSeconds,
          streamLeadSeconds: 0,
        }),
      ).toBe(expected);
    },
  );

  const base = {
    startTime: 0.68,
    firstFrame: 13,
    tailFrames: 25,
    outputFps: 25,
    sourceFps: 60,
    finalFrameSeconds: 2.05,
    streamLeadSeconds: 0,
  };

  it("declines a stream that starts after the file does, an unknown source rate and an empty tail", () => {
    expect(tailFramesFromFinalFrame(base)).toBe(22);
    expect(tailFramesFromFinalFrame({ ...base, streamLeadSeconds: 0.3 })).toBeNull();
    expect(tailFramesFromFinalFrame({ ...base, sourceFps: 12.37 })).toBeNull();
    expect(tailFramesFromFinalFrame({ ...base, startTime: 9 })).toBeNull();
  });
});
