import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";
import {
  stopTestProcesses,
  testProcessDescendants,
  testProcessIsAlive,
  waitForTestCondition,
} from "./utils/processTestUtils.js";

const here = dirname(fileURLToPath(import.meta.url));
const env = { ...process.env, HYPERFRAMES_NO_TELEMETRY: "1", DO_NOT_TRACK: "1" };
const CHECK_ARGS = ["--json", "--no-browser-gpu", "--samples=1"];
const CHROME = /chrom/i;
let addresses = 0;

function project(hang = false): string {
  const dir = mkdtempSync(join(tmpdir(), "hf-warm-check-"));
  mkdirSync(join(dir, "compositions"));
  const scene = hang
    ? `<div data-composition-id="hang" data-composition-src="compositions/hang.html" data-start="0" data-duration="1"></div>`
    : `<p style="color:#fff;background:#000">Warm</p>`;
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html><html><body>
<div data-composition-id="main" data-width="320" data-height="180" data-duration="1">${scene}</div>
<script>window.__timelines.main={duration:()=>1,seek:()=>{},pause:()=>{}};</script></body></html>`,
  );
  writeFileSync(
    join(dir, "compositions/hang.html"),
    `<template id="hang"><div data-composition-id="hang"><div id="box" style="width:1px;height:1px"></div>
<script>const el=document.getElementById("box");while(el.offsetWidth<2){el.style.height="1px";}</script>
</div></template>`,
  );
  onTestFinished(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

function address(dir: string): string {
  addresses += 1;
  return process.platform === "win32"
    ? `\\\\.\\pipe\\hf-warm-check-test-${process.pid}-${addresses}`
    : join(dir, "warm.sock");
}

function run(args: string[], extraEnv: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["--import", "tsx", ...args], {
    env: { ...env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (data: Buffer) => (stdout += data.toString()));
  child.stderr.on("data", () => {});
  const done = new Promise<number | null>((resolve) => child.once("close", resolve));
  onTestFinished(() => stopTestProcesses(child, []));
  return { child, done, stdout: () => stdout };
}

async function warmProcess(dir: string, idleMs = 60_000) {
  const socketAddress = address(dir);
  const warm = run([join(here, "warmCheck.ts"), socketAddress, String(idleMs), dir, ...CHECK_ARGS]);
  const pid = warm.child.pid!;
  let chrome: number[] = [];
  onTestFinished(() => stopTestProcesses(warm.child, testProcessDescendants(pid)));
  await waitForTestCondition(() => {
    chrome = testProcessDescendants(pid, CHROME);
    return chrome.length > 0;
  }, 30_000);
  const serving = () =>
    existsSync(join(dir, ".hyperframes")) && readdirSync(join(dir, ".hyperframes")).length > 0;
  return { ...warm, pid, chrome: () => chrome, serving, address: socketAddress };
}

function client(socketAddress: string, dir: string, extraEnv: Record<string, string> = {}) {
  return run(
    [join(here, "warmCheckClient.fixture.ts"), socketAddress, "check", dir, ...CHECK_ARGS],
    extraEnv,
  );
}

function gone(pids: number[]): boolean {
  return pids.every((pid) => !testProcessIsAlive(pid));
}

function findings(json: string) {
  const report = JSON.parse(json.slice(json.indexOf("{"))) as { saved?: unknown };
  delete report.saved;
  return report;
}

it("serves a check that prints what a cold check prints, then exits with its Chrome", async () => {
  const dir = project();
  const warm = await warmProcess(dir);
  const chrome = warm.chrome();
  const served = client(warm.address, dir);
  expect(await served.done).toBe(0);
  await waitForTestCondition(() => !testProcessIsAlive(warm.pid) && gone(chrome), 10_000);

  const cold = run([join(here, "cli.ts"), "check", dir, ...CHECK_ARGS]);
  expect(await cold.done).toBe(0);
  expect(findings(served.stdout())).toEqual(findings(cold.stdout()));
}, 120_000);

it("exits with its Chrome when a connection closes without a request", async () => {
  const warm = await warmProcess(project());
  const chrome = warm.chrome();
  await new Promise<void>((resolve) => {
    const probe = connect(warm.address, () => probe.destroy());
    probe.once("close", () => resolve());
    probe.once("error", () => resolve());
  });
  await waitForTestCondition(() => !testProcessIsAlive(warm.pid) && gone(chrome), 10_000);
}, 60_000);

it("takes its Chrome with it when the warm process is killed", async () => {
  const warm = await warmProcess(project());
  const chrome = warm.chrome();
  warm.child.kill("SIGKILL");
  await waitForTestCondition(() => gone(chrome), 10_000);
}, 60_000);

it("stops with its Chrome when the client is killed mid-check", async () => {
  const dir = project(true);
  const warm = await warmProcess(dir);
  const chrome = warm.chrome();
  const served = client(warm.address, dir);
  await waitForTestCondition(warm.serving, 30_000);
  served.child.kill("SIGKILL");
  await waitForTestCondition(() => !testProcessIsAlive(warm.pid) && gone(chrome), 10_000);
}, 60_000);

it("exits with its Chrome after its idle window", async () => {
  const warm = await warmProcess(project(), 1_000);
  const chrome = warm.chrome();
  await waitForTestCondition(() => !testProcessIsAlive(warm.pid) && gone(chrome), 20_000);
}, 60_000);

it("declines a client whose environment differs, and exits", async () => {
  const dir = project();
  const warm = await warmProcess(dir);
  const declined = client(warm.address, dir, { HF_WARM_TEST_EXTRA: "1" });
  expect(await declined.done).toBe(0);
  expect(declined.stdout()).toBe("NOT SERVED\n");
  await waitForTestCondition(() => !testProcessIsAlive(warm.pid), 10_000);
}, 60_000);

it("leaves a second client to run cold while it serves the first", async () => {
  const dir = project(true);
  const warm = await warmProcess(dir);
  client(warm.address, dir);
  await waitForTestCondition(warm.serving, 30_000);
  const second = client(warm.address, dir);
  expect(await second.done).toBe(0);
  expect(second.stdout()).toBe("NOT SERVED\n");
}, 60_000);
