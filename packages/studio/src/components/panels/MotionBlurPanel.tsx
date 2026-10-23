import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Composition } from "@hyperframes/sdk";
import type { MotionBlurSettings } from "@hyperframes/core/motion-blur-settings";
import { useStudioPlaybackContext, useStudioShellContext } from "../../contexts/StudioContext";
import { useFileManagerContext } from "../../contexts/FileManagerContext";
import {
  useVariablesPersist,
  type UseVariablesPersistParams,
} from "../../hooks/useVariablesPersist";
import { resolveMasterCompositionPath } from "../../utils/studioUrlState";
import { Button } from "../ui";
import {
  BLUR_LEVELS,
  changedEdits,
  findCompositionRoot,
  levelOf,
  patchForLevel,
  readPreviewRootAttributes,
  sameAttributes,
  settingsOf,
  withEdits,
  type BlurLevel,
  type RootAttributes,
} from "./motionBlurPanelModel";

export interface MotionBlurPanelProps {
  sdkSession: Composition | null;
  publishSdkSession?: UseVariablesPersistParams["publishSdkSession"];
  reloadPreview: () => void;
  recordEdit: UseVariablesPersistParams["recordEdit"];
}

const POLL_MS = 500;
/** After a write the preview is reloading: keep what was just written instead of the old document. */
const SETTLE_MS = 1500;

/** The preview's own root attributes, polled; `hold` pins an optimistic value until the preview catches up. */
function useLivePreviewAttributes(
  previewIframeRef: { current: HTMLIFrameElement | null },
  refreshKey: number,
) {
  const [live, setLive] = useState<RootAttributes | null>(null);
  const holdUntil = useRef(0);
  useEffect(() => {
    const read = () => {
      const found = readPreviewRootAttributes(previewIframeRef.current);
      if (found && Date.now() >= holdUntil.current) {
        setLive((current) => (sameAttributes(current, found) ? current : found));
      }
    };
    read();
    const timer = setInterval(read, POLL_MS);
    return () => clearInterval(timer);
  }, [previewIframeRef, refreshKey]);
  const hold = useCallback((next: (current: RootAttributes | null) => RootAttributes) => {
    holdUntil.current = Date.now() + SETTLE_MS;
    setLive(next);
  }, []);
  return [live, hold] as const;
}

export const MotionBlurPanel = memo(function MotionBlurPanel({
  sdkSession,
  publishSdkSession,
  reloadPreview,
  recordEdit,
}: MotionBlurPanelProps) {
  const { activeCompPath, previewIframeRef, showToast } = useStudioShellContext();
  const { refreshKey } = useStudioPlaybackContext();
  const { readProjectFile, writeProjectFile, compositions } = useFileManagerContext();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [live, hold] = useLivePreviewAttributes(previewIframeRef, refreshKey);

  useEffect(() => sdkSession?.on("change", rerender), [sdkSession]);

  const root = sdkSession ? findCompositionRoot(sdkSession.getRootElements()) : null;
  // The preview's own root is the truth after an undo or an outside edit, which the shared session does not follow.
  const attributes = live ?? root?.attributes ?? null;
  const settings = useMemo(() => (attributes ? settingsOf(attributes) : null), [attributes]);
  const isMain =
    activeCompPath == null || activeCompPath === resolveMasterCompositionPath(compositions);
  const persist = useVariablesPersist({
    sdkSession,
    activeCompPath,
    readProjectFile,
    writeProjectFile,
    recordEdit,
    reloadPreview,
    publishSdkSession,
  });

  const apply = useCallback(
    async (patch: Partial<MotionBlurSettings>) => {
      if (!root || !settings || !attributes) return;
      const edits = changedEdits(attributes, { ...settings, ...patch });
      if (edits.length === 0) return;
      try {
        await persist("Edit motion blur", (session) => {
          for (const e of edits) {
            session.dispatch({
              type: "setAttribute",
              target: root.id,
              name: e.name,
              value: e.value,
            });
          }
        });
        hold((current) => withEdits(current ?? attributes, edits));
        rerender();
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [root, settings, attributes, persist, hold, showToast],
  );

  if (!settings) {
    return (
      <p className="p-3 text-[10px] leading-relaxed text-neutral-500">
        Open a composition to set up motion blur.
      </p>
    );
  }
  const locked = !isMain;
  const current = levelOf(settings);

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3 text-[11px] text-neutral-300">
      <span className="text-[12px] font-medium text-neutral-100">Motion blur</span>
      <div role="radiogroup" aria-label="Motion blur" className="flex gap-1.5">
        {BLUR_LEVELS.map(({ level, label }) => (
          <Button
            key={level}
            role="radio"
            aria-checked={current === level}
            size="sm"
            variant={current === level ? "secondary" : "ghost"}
            className="flex-1"
            disabled={locked}
            onClick={() => void apply(patchForLevel(level as BlurLevel))}
          >
            {label}
          </Button>
        ))}
      </div>
      {locked ? (
        <p className="text-[10px] leading-relaxed text-amber-400/90">
          Motion blur is read from the main composition. Open it to change this setting.
        </p>
      ) : null}
    </div>
  );
});
