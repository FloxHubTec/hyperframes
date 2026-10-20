import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const probeTracker = vi.hoisted(() => {
  let active = 0;
  let maxActive = 0;
  let started = 0;
  let startedByKind: Record<string, number> = {};
  let gatedKinds = new Set<string>();
  let failingKinds = new Set<string>();
  let releaseGate = () => {};
  let gate: Promise<void>;

  const reset = () => {
    active = 0;
    maxActive = 0;
    started = 0;
    startedByKind = {};
    gatedKinds = new Set(["metadata", "keyframes", "profile"]);
    failingKinds = new Set();
    gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
  };
  reset();

  return {
    reset,
    release: () => releaseGate(),
    ungate: (kind: string) => gatedKinds.delete(kind),
    fail: (kind: string) => failingKinds.add(kind),
    run: async <T>(kind: string, value: T): Promise<T> => {
      active += 1;
      started += 1;
      startedByKind[kind] = (startedByKind[kind] ?? 0) + 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (gatedKinds.has(kind)) await gate;
        if (failingKinds.has(kind)) throw new Error(`[FFmpeg] ffprobe timeout with code null`);
        return value;
      } finally {
        active -= 1;
      }
    },
    startedOf: (kind: string) => startedByKind[kind] ?? 0,
    get active() {
      return active;
    },
    get maxActive() {
      return maxActive;
    },
    get started() {
      return started;
    },
  };
});

vi.mock("@hyperframes/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hyperframes/engine")>();
  return {
    ...actual,
    analyzeKeyframeIntervals: async () =>
      probeTracker.run("keyframes", { isProblematic: false, maxIntervalSeconds: 0 }),
    probeMediaProfile: async () =>
      probeTracker.run("profile", {
        hasVideoStream: true,
        hasAudioStream: true,
        visualKind: "moving",
      }),
  };
});

vi.mock("../utils/ffprobe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/ffprobe.js")>();
  return {
    ...actual,
    extractMediaMetadata: async () =>
      probeTracker.run("metadata", { durationSeconds: 1, isVFR: false }),
  };
});

import { compileForRender } from "./htmlCompiler.js";
import { preflightCompositionAssetMediaTypes } from "./assetMediaType.js";
import { sharedMediaProbeSemaphore } from "../utils/mediaProbeConcurrency.js";

function writeProject(projectDir: string, sources: string[]): string {
  const mediaMarkup = sources.map((src, index) => {
    writeFileSync(join(projectDir, src), "fixture");
    return `<video id="video-${index}" src="${src}" loop data-start="0" data-duration="1"></video>`;
  });
  const htmlPath = join(projectDir, "index.html");
  writeFileSync(
    htmlPath,
    `<!doctype html><html><body>
      <div data-composition-id="root" data-width="320" data-height="180" data-duration="1">
        ${mediaMarkup.join("\n")}
      </div>
    </body></html>`,
  );
  return htmlPath;
}

const nextMacrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function waitForProbesToDrain(): Promise<void> {
  let idleTicks = 0;
  for (let tick = 0; tick < 500 && idleTicks < 3; tick += 1) {
    await nextMacrotask();
    const idle =
      probeTracker.active === 0 &&
      sharedMediaProbeSemaphore.activeCount === 0 &&
      sharedMediaProbeSemaphore.waitingCount === 0;
    idleTicks = idle ? idleTicks + 1 : 0;
  }
}

describe("aggregate media-probe concurrency", () => {
  let projectDir: string | undefined;

  afterEach(async () => {
    probeTracker.release();
    await waitForProbesToDrain();
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
    projectDir = undefined;
  });

  it("caps overlapping compiler advisories and media-type preflight at four probes", async () => {
    probeTracker.reset();
    projectDir = mkdtempSync(join(tmpdir(), "hf-media-probe-concurrency-"));
    const htmlPath = writeProject(
      projectDir,
      Array.from({ length: 6 }, (_, index) => `video-${index}.asset`),
    );

    const compiled = await compileForRender(projectDir, htmlPath, join(projectDir, "downloads"));
    const preflight = preflightCompositionAssetMediaTypes({
      projectDir,
      compiledDir: join(projectDir, "compiled"),
      composition: compiled,
    });

    // Let all fire-and-forget advisory calls and the preflight contend for the
    // shared limiter while their mocked probe bodies remain blocked.
    for (let tick = 0; tick < 50 && probeTracker.active < 4; tick += 1) await nextMacrotask();
    await nextMacrotask();
    expect(probeTracker.maxActive).toBe(4);

    probeTracker.release();
    await preflight;
    await waitForProbesToDrain();
    expect(probeTracker.started).toBe(18);
    expect(probeTracker.maxActive).toBe(4);
  });

  it("runs the advisory probes once per source file, not once per clip cut from it", async () => {
    probeTracker.reset();
    probeTracker.ungate("metadata");
    probeTracker.ungate("keyframes");
    projectDir = mkdtempSync(join(tmpdir(), "hf-media-probe-dedupe-"));
    const htmlPath = writeProject(projectDir, [
      ...Array.from({ length: 8 }, () => "interview.asset"),
      ...Array.from({ length: 5 }, () => "broll.asset"),
    ]);

    await compileForRender(projectDir, htmlPath, join(projectDir, "downloads"));
    await waitForProbesToDrain();

    expect(probeTracker.startedOf("metadata")).toBe(2);
    expect(probeTracker.startedOf("keyframes")).toBe(2);
  });

  it("does not restart a timed-out keyframe scan for the next clip of the same file", async () => {
    probeTracker.reset();
    probeTracker.ungate("metadata");
    probeTracker.ungate("keyframes");
    probeTracker.fail("keyframes");
    projectDir = mkdtempSync(join(tmpdir(), "hf-media-probe-timeout-"));
    const htmlPath = writeProject(
      projectDir,
      Array.from({ length: 12 }, () => "camera-a.asset"),
    );

    await compileForRender(projectDir, htmlPath, join(projectDir, "downloads"));
    await waitForProbesToDrain();

    expect(probeTracker.startedOf("keyframes")).toBe(1);
  });

  it("lets media-type preflight finish while advisory scans are still running", async () => {
    probeTracker.reset();
    probeTracker.ungate("profile");
    projectDir = mkdtempSync(join(tmpdir(), "hf-media-probe-preflight-"));
    const htmlPath = writeProject(
      projectDir,
      Array.from({ length: 6 }, (_, index) => `source-${index}.asset`),
    );

    const compiled = await compileForRender(projectDir, htmlPath, join(projectDir, "downloads"));
    const preflight = preflightCompositionAssetMediaTypes({
      projectDir,
      compiledDir: join(projectDir, "compiled"),
      composition: compiled,
    }).then(() => "finished" as const);
    const stillBlocked = (async () => {
      for (let tick = 0; tick < 20; tick += 1) await nextMacrotask();
      return "blocked behind advisory scans" as const;
    })();

    expect(await Promise.race([preflight, stillBlocked])).toBe("finished");
    expect(probeTracker.startedOf("profile")).toBe(6);
    expect(probeTracker.maxActive).toBeLessThanOrEqual(4);
  });
});
