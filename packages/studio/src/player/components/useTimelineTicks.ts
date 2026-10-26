import { useMemo } from "react";
import type { TimelineTimeDisplayMode } from "../../utils/studioUiPreferences";
import { useLinkedClipPreferences } from "../../utils/linkedClipPreferences";
import type { TimelineTimeRange } from "../lib/timelineClipIndex";
import {
  generateTicks,
  getTimelineMajorTickInterval,
  rulerFrameRate,
} from "./timelineRulerGeometry";

export function useTimelineTicks(
  duration: number,
  pixelsPerSecond: number,
  timeDisplayMode: TimelineTimeDisplayMode,
  renderTimeRange?: TimelineTimeRange,
) {
  const compositionFps = useLinkedClipPreferences((s) => s.compositionFps);
  const frameRate = rulerFrameRate(timeDisplayMode, compositionFps);
  const ticks = useMemo(
    () => generateTicks(duration, pixelsPerSecond, frameRate, renderTimeRange),
    [duration, frameRate, pixelsPerSecond, renderTimeRange],
  );
  return {
    ...ticks,
    majorTickInterval: getTimelineMajorTickInterval(duration, pixelsPerSecond, frameRate),
  };
}
