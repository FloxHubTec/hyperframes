// @vitest-environment happy-dom

/**
 * "Install the desktop app": shown where the preview server has the app or its download to offer; a press opens the
 * project in the app here, or goes to hyperframes.dev's download.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const showToast = vi.fn();
vi.mock("../contexts/StudioContext", () => ({ useStudioShellContext: () => ({ showToast }) }));
const track = vi.fn();
vi.mock("../utils/studioTelemetry", () => ({ trackStudioEvent: track }));

const { OpenInDesktopButton } = await import("./OpenInDesktopButton");

const DOWNLOAD = "https://hyperframes.dev/studio/download";
let mounted: { root: Root; host: HTMLElement } | null = null;
let posts: number;

function serve(get: Response | null, post?: unknown) {
  posts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts += 1;
        return Response.json(post);
      }
      return get ?? new Response("Not found", { status: 404 });
    }),
  );
}

async function mount(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => root.render(<OpenInDesktopButton />));
  return host;
}

const button = () =>
  document.querySelector<HTMLButtonElement>('[data-testid="header-open-in-desktop"]');

let reveal: (() => void) | null = null;

beforeEach(() => {
  showToast.mockReset();
  track.mockReset();
  reveal = null;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private readonly onChange: (entries: { isIntersecting: boolean }[]) => void) {}
      observe() {
        reveal = () => this.onChange([{ isIntersecting: true }]);
      }
      disconnect() {
        reveal = null;
      }
    },
  );
});

const events = (name: string) =>
  track.mock.calls.filter(([event]) => event === name).map(([, props]) => props);
const MAC = { os: "darwin", app_installed: true, download_available: true };

afterEach(() => {
  vi.unstubAllGlobals();
  if (!mounted) return;
  const { root, host } = mounted;
  mounted = null;
  act(() => root.unmount());
  host.remove();
});

it("stays hidden where the server has no hand-off (the desktop's own Studio)", async () => {
  serve(null);
  await mount();
  expect(button()).toBeNull();
});

it("stays hidden when the app has no build for this machine (Windows)", async () => {
  serve(Response.json({ available: false, handoff: true, downloadUrl: null }));
  await mount();
  expect(button()).toBeNull();
});

it("with the app installed but no download (Windows), shows only once the app can take the project", async () => {
  serve(Response.json({ available: true, handoff: false, downloadUrl: null }));
  await mount();
  expect(button()).toBeNull();
});

it("opens the project in an installed app that has no download (Windows)", async () => {
  serve(Response.json({ available: true, handoff: true, downloadUrl: null }), {
    opened: true,
    app: "the HyperFrames desktop app",
  });
  await mount();
  await act(async () => button()!.click());
  expect(posts).toBe(1);
});

it("reads exactly 'Install the desktop app' beside Framey", async () => {
  serve(Response.json({ available: true, handoff: true, downloadUrl: DOWNLOAD }));
  await mount();
  expect(button()!.textContent).toBe("Install the desktop app");
  expect(button()!.querySelector("svg .hf-framey-eye")).not.toBeNull();
});

it("without the app here, is a link to hyperframes.dev's download and opens nothing", async () => {
  const linux = `${DOWNLOAD}?os=linux`;
  serve(Response.json({ available: true, handoff: false, downloadUrl: linux }), { opened: true });
  await mount();
  const link = button()!;
  expect(link.tagName).toBe("A");
  expect(link.getAttribute("href")).toBe(linux);
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.textContent).toBe("Install the desktop app");
  await act(async () => link.click());
  expect(posts).toBe(0);
});

it("opens the project in the app and says so", async () => {
  serve(Response.json({ available: true, handoff: true, downloadUrl: DOWNLOAD }), {
    opened: true,
    app: "the HyperFrames desktop app",
  });
  await mount();
  await act(async () => button()!.click());
  expect(posts).toBe(1);
  expect(showToast).toHaveBeenCalledWith(
    "Opening this project in the HyperFrames desktop app",
    "info",
  );
  expect(button()!.dataset.opening).toBe("true");
});

it("goes to the download when the app could not take the project", async () => {
  const opened: string[] = [];
  vi.stubGlobal("open", (url: string) => (opened.push(url), {}));
  serve(Response.json({ available: true, handoff: true, downloadUrl: DOWNLOAD }), {
    opened: false,
    reason: "open-failed",
    downloadUrl: DOWNLOAD,
  });
  await mount();
  await act(async () => button()!.click());
  expect(opened).toEqual([DOWNLOAD]);
  expect(showToast).not.toHaveBeenCalled();
});

it("names the download when the browser blocks the new tab", async () => {
  vi.stubGlobal("open", () => null);
  serve(Response.json({ available: true, handoff: true, downloadUrl: DOWNLOAD }), {
    opened: false,
    reason: "not-installed",
    downloadUrl: DOWNLOAD,
  });
  await mount();
  await act(async () => button()!.click());
  expect(showToast).toHaveBeenCalledWith(`Get the HyperFrames desktop app at ${DOWNLOAD}`, "info");
});

it("counts where the button can show, the app here, and platforms with no app", async () => {
  serve(
    Response.json({
      ...MAC,
      available: true,
      handoff: true,
      downloadUrl: DOWNLOAD,
      installed: true,
    }),
  );
  await mount();
  expect(events("desktop_cta_eligibility")).toEqual([{ eligibility: "open_in_app", ...MAC }]);
  act(() => mounted!.root.unmount());
  mounted = null;

  track.mockReset();
  serve(
    Response.json({
      available: false,
      handoff: false,
      downloadUrl: null,
      os: "win32",
      installed: false,
    }),
  );
  await mount();
  expect(button()).toBeNull();
  expect(events("desktop_cta_eligibility")).toEqual([
    {
      eligibility: "no_app_for_platform",
      os: "win32",
      app_installed: false,
      download_available: false,
    },
  ]);
  expect(events("desktop_cta_impression")).toEqual([]);
});

it("records one impression, only once the button is on screen", async () => {
  serve(
    Response.json({
      ...MAC,
      available: true,
      handoff: true,
      downloadUrl: DOWNLOAD,
      installed: true,
    }),
  );
  await mount();
  expect(events("desktop_cta_impression")).toEqual([]);
  act(() => reveal!());
  expect(events("desktop_cta_impression")).toEqual([{ eligibility: "open_in_app", ...MAC }]);
  expect(reveal).toBeNull();
});

it("records the click and its outcome for each way a press ends", async () => {
  const outcomes = async (post: unknown, open: (url: string) => unknown = () => ({})) => {
    track.mockReset();
    vi.stubGlobal("open", open);
    serve(
      Response.json({
        ...MAC,
        available: true,
        handoff: true,
        downloadUrl: DOWNLOAD,
        installed: true,
      }),
      post,
    );
    await mount();
    await act(async () => button()!.click());
    const result = { clicks: events("toolbar_action"), outcomes: events("desktop_cta_outcome") };
    act(() => mounted!.root.unmount());
    mounted = null;
    return result;
  };
  expect(await outcomes({ opened: true })).toEqual({
    clicks: [{ action: "open_in_desktop", ...MAC }],
    outcomes: [{ outcome: "opened", ...MAC }],
  });
  const missing = { opened: false, reason: "not-installed", downloadUrl: DOWNLOAD };
  expect((await outcomes(missing)).outcomes).toEqual([
    { outcome: "sent_to_download", reason: "not-installed", ...MAC },
  ]);
  expect((await outcomes(missing, () => null)).outcomes).toEqual([
    { outcome: "failed", reason: "download_tab_blocked", ...MAC },
  ]);
});

it("records a press the preview server never answered as failed", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") throw new TypeError("network");
      return Response.json({
        ...MAC,
        available: true,
        handoff: true,
        downloadUrl: DOWNLOAD,
        installed: true,
      });
    }),
  );
  await mount();
  await act(async () => button()!.click());
  expect(events("desktop_cta_outcome")).toEqual([
    { outcome: "failed", reason: "preview_server_unreachable", ...MAC },
  ]);
});

it("records the download link's press as sent to the download, never as an install", async () => {
  const linux = { os: "linux", app_installed: false, download_available: true };
  serve(
    Response.json({
      ...linux,
      available: true,
      handoff: false,
      downloadUrl: `${DOWNLOAD}?os=linux`,
      installed: false,
    }),
  );
  await mount();
  await act(async () => button()!.click());
  expect(events("toolbar_action")).toEqual([{ action: "get_desktop_app", ...linux }]);
  expect(events("desktop_cta_outcome")).toEqual([{ outcome: "sent_to_download", ...linux }]);
  const sent = JSON.stringify(track.mock.calls);
  expect(sent).not.toMatch(/"outcome":"[a-z_]*install/);
  expect(sent).not.toContain("/");
});
