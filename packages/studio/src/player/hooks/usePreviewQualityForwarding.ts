import { useEffect } from "react";
import { usePlayerStore } from "../store/playerStore";
import { postRuntimeControlMessage } from "../lib/runtimeProtocol";

/** Sends the preview quality, and each retry, to the live preview; a reloaded preview asks again when it is ready. */
export function usePreviewQualityForwarding(iframe: HTMLIFrameElement | null): void {
  const level = usePlayerStore((state) => state.previewQuality);
  const retries = usePlayerStore((state) => state.previewCopiesRetry);
  useEffect(() => {
    if (iframe) postRuntimeControlMessage(iframe.contentWindow, "set-preview-quality", { level });
  }, [iframe, level]);
  useEffect(() => {
    if (iframe && retries > 0) postRuntimeControlMessage(iframe.contentWindow, "retry-preview-copies");
  }, [iframe, retries]);
}
