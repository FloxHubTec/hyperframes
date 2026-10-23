/**
 * Runs in the page before any script. A video whose frames the render extracts is never decoded by
 * the page; held at preload none from the moment it is parsed (Chrome's default would start it, and
 * ignores a later none), a film cut into N pieces would otherwise mount N decoders at once.
 */
export function holdRenderFrameVideos(ids: readonly string[]): void {
  const held = new Set(ids);
  (
    window as Window & { __HF_RENDER_FRAME_VIDEO_IDS?: readonly string[] }
  ).__HF_RENDER_FRAME_VIDEO_IDS = ids;
  const hold = (el: Element) => {
    if (el instanceof HTMLVideoElement && held.has(el.id)) el.preload = "none";
  };
  new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        hold(node as Element);
        for (const video of (node as Element).querySelectorAll("video")) hold(video);
      }
  }).observe(document, { childList: true, subtree: true });
}
