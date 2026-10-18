import { useEffect, useRef, useState } from "react";
import { useStudioShellContext } from "../contexts/StudioContext";
import { studioApiFetch } from "../utils/studioApiFetch";
import { trackStudioEvent } from "../utils/studioTelemetry";
import { FrameyGlyph } from "./FrameyGlyph";
import { Button, buttonBase, buttonSizes, buttonVariants, cn } from "./ui";

// "Install the desktop app": the preview server (`/api/open-in-desktop`) says whether to show it and whether the app
// here takes the project; a press opens the project in the app, or goes to hyperframes.dev's download.
const ROUTE = "/api/open-in-desktop";
/** How far the pupils travel towards the pointer, in the glyph's own units. */
const GAZE = 2.2;
/** Long enough for the flight to finish before the label comes back. */
const OPENING_MS = 1600;

type OpenResult = { opened: true } | { opened: false; reason: string; downloadUrl: string };

type DesktopRoute = { handoff: boolean; downloadUrl: string | null };

/** Null hides the button: no route (the app's own Studio), or nothing here to open or download. */
function useDesktopRoute(): DesktopRoute | null {
  const [route, setRoute] = useState<DesktopRoute | null>(null);
  useEffect(() => {
    let live = true;
    studioApiFetch(ROUTE)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { available?: unknown; handoff?: unknown; downloadUrl?: unknown } | null) => {
        if (!live || body?.available !== true) return;
        const handoff = body.handoff === true;
        const downloadUrl = typeof body.downloadUrl === "string" ? body.downloadUrl : null;
        if (handoff || downloadUrl) setRoute({ handoff, downloadUrl });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return route;
}

/** Framey looks at the pointer: one listener, one write per frame, no re-render. */
function useGaze(
  anchor: React.RefObject<HTMLElement | null>,
  eye: React.RefObject<SVGGElement | null>,
) {
  useEffect(() => {
    let frame = 0;
    const look = (event: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const box = anchor.current?.getBoundingClientRect();
        if (!box || !eye.current) return;
        const dx = event.clientX - (box.left + box.height / 2);
        const dy = event.clientY - (box.top + box.height / 2);
        const distance = Math.hypot(dx, dy) || 1;
        eye.current.style.transform = `translate(${(dx / distance) * GAZE}px, ${(dy / distance) * GAZE}px)`;
      });
    };
    window.addEventListener("pointermove", look);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", look);
    };
  }, [anchor, eye]);
}

const LABEL = "Install the desktop app";
const LOOK =
  "hf-framey-trigger gap-1.5 border border-accent/40 bg-accent/10 pl-1 font-semibold text-text-0 enabled:hover:bg-accent/20 hover:bg-accent/20";

export function OpenInDesktopButton() {
  const { showToast } = useStudioShellContext();
  const route = useDesktopRoute();
  const [opening, setOpening] = useState(false);
  const trigger = useRef<HTMLElement>(null);
  const eye = useRef<SVGGElement>(null);
  useGaze(trigger, eye);
  if (!route) return null;
  const icon = <FrameyGlyph size={24} className="hf-framey" eyeRef={eye} />;

  if (!route.handoff) {
    if (!route.downloadUrl) return null;
    return (
      <a
        ref={trigger as React.RefObject<HTMLAnchorElement>}
        href={route.downloadUrl}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="header-open-in-desktop"
        title="Download the free HyperFrames desktop app from hyperframes.dev"
        className={cn(buttonBase, buttonVariants.ghost, buttonSizes.md, LOOK)}
        onClick={() => trackStudioEvent("toolbar_action", { action: "get_desktop_app" })}
      >
        {icon}
        {LABEL}
      </a>
    );
  }

  const download = (url: string) => {
    const tab = window.open(url, "_blank");
    if (tab) tab.opener = null;
    else showToast(`Get the HyperFrames desktop app at ${url}`, "info");
  };

  const open = async () => {
    if (opening) return;
    setOpening(true);
    trackStudioEvent("toolbar_action", { action: "open_in_desktop" });
    try {
      const res = await studioApiFetch(ROUTE, { method: "POST" });
      const result = (await res.json()) as OpenResult;
      if (result.opened) {
        showToast("Opening this project in the HyperFrames desktop app", "info");
        await new Promise((done) => setTimeout(done, OPENING_MS));
      } else download(result.downloadUrl);
    } catch {
      showToast("Couldn't reach the preview server to open the app", "error");
    } finally {
      setOpening(false);
    }
  };

  return (
    <Button
      ref={trigger as React.RefObject<HTMLButtonElement>}
      variant="ghost"
      data-testid="header-open-in-desktop"
      data-opening={opening || undefined}
      title="Open this project in the HyperFrames desktop app"
      className={LOOK}
      icon={icon}
      onClick={() => void open()}
    >
      {opening ? "Opening in the app…" : LABEL}
    </Button>
  );
}
