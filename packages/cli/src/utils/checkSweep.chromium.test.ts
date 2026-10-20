// Real-Chromium pins for the frozen-sweep guard: paint the DOM signature cannot read must still count as motion.
// Skipped without a local Chrome; opt-in on Windows (HYPERFRAMES_BROWSER_TESTS=1), like the other Chromium suites.
import { existsSync } from "node:fs";
import type { Browser } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findSystemBrowser } from "../browser/manager.js";
import { createPageDriver } from "./checkBrowser.js";
import { DEFAULT_CHECK_OPTIONS, runAuditGrid } from "./checkPipeline.js";

function resolveExecutable(): string | undefined {
  for (const name of ["HYPERFRAMES_BROWSER_PATH", "PUPPETEER_EXECUTABLE_PATH"]) {
    const candidate = process.env[name];
    if (candidate && existsSync(candidate)) return candidate;
  }
  return findSystemBrowser()?.executablePath;
}

const executablePath = resolveExecutable();
const RUNS_CHROMIUM =
  !!executablePath &&
  (process.platform !== "win32" || process.env.HYPERFRAMES_BROWSER_TESTS === "1");
const BROWSER_LAUNCH_TIMEOUT_MS = 120_000;

// A 6 s film whose only motion is what `draw(t)` paints; `window.__hf` is the seek target check drives.
function film(body: string, draw: string): string {
  return `<!doctype html><html><head><style>
    html, body { margin: 0; width: 640px; height: 360px; overflow: hidden; background: #0a0a0a; }
  </style></head><body>
    <div id="root" data-composition-id="main" data-duration="6" data-width="640" data-height="360">${body}</div>
    <script>
      const draw = (t) => { ${draw} };
      window.__hf = { duration: 6, seek: draw };
      draw(0);
    </script>
  </body></html>`;
}

const MOVING_FILMS: [string, string][] = [
  [
    "an SVG mask whose circle radius grows",
    film(
      `<svg width="640" height="360"><defs><mask id="m"><rect width="640" height="360" fill="black"/>
        <circle id="hole" cx="320" cy="180" r="0" fill="white"/></mask></defs>
        <rect width="640" height="360" fill="#ff5a1f" mask="url(#m)"/></svg>`,
      `document.getElementById("hole").setAttribute("r", String(t * 60));`,
    ),
  ],
  [
    "a stroke-dashoffset line reveal",
    film(
      `<svg width="640" height="360"><path id="line" d="M40 180 C 200 20, 440 340, 600 180"
        stroke="#fff" stroke-width="4" fill="none" stroke-dasharray="800" stroke-dashoffset="800"/></svg>`,
      `document.getElementById("line").setAttribute("stroke-dashoffset", String(800 - t * 130));`,
    ),
  ],
  [
    "a thin line drawn on a 2D canvas",
    film(
      `<canvas id="c" width="640" height="360"></canvas>`,
      `const ctx = document.getElementById("c").getContext("2d");
       ctx.clearRect(0, 0, 640, 360); ctx.strokeStyle = "#4ade80"; ctx.lineWidth = 1; ctx.beginPath();
       ctx.moveTo(40, 180); ctx.lineTo(40 + t * 90, 180 - t * 20); ctx.stroke();`,
    ),
  ],
  [
    "a WebGL canvas whose clear color fades",
    film(
      `<canvas id="c" width="640" height="360"></canvas>`,
      `const gl = document.getElementById("c").getContext("webgl");
       gl.clearColor(t / 6, 0.2, 0.4, 1); gl.clear(gl.COLOR_BUFFER_BIT);`,
    ),
  ],
];

describe.skipIf(!RUNS_CHROMIUM)("frozen-sweep guard in Chromium", () => {
  let browser: Browser;

  beforeAll(async () => {
    const puppeteer = await import("puppeteer-core");
    browser = await puppeteer.default.launch({
      headless: true,
      executablePath,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
  }, BROWSER_LAUNCH_TIMEOUT_MS);

  afterAll(async () => {
    await browser?.close();
  });

  // A page per film: setContent keeps the window, so one film's globals would leak into the next.
  async function sweepFindings(html: string): Promise<string[]> {
    const page = await browser.newPage();
    await page.setViewport({ width: 640, height: 360 });
    await page.setContent(html);
    const result = await runAuditGrid(
      createPageDriver(page),
      { ...DEFAULT_CHECK_OPTIONS, contrast: false },
      { kind: "none" },
    ).finally(() => page.close());
    return result.layoutIssues
      .filter((issue) => issue.code === "sweep_static")
      .map((issue) => issue.message);
  }

  it.each(MOVING_FILMS)("does not call %s static", async (_, html) => {
    expect(await sweepFindings(html)).toEqual([]);
  });

  it("still warns on a film where nothing on screen moves", async () => {
    const still = film(
      `<h1 style="margin: 0; padding: 140px 0 0 200px; color: #fff; font: 600 48px sans-serif">Still</h1>`,
      "",
    );
    expect(await sweepFindings(still)).toEqual(["Nothing on screen moved under seek."]);
  });
});
