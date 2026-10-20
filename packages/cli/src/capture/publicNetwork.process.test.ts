import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";
import { startTestDnsServer } from "../utils/dnsTestServer.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "publicNetwork.fixture.ts");

/** What the fixture printed, and how long its process lived after printing it. */
async function resolveInChild(mode: "silent" | "answer", system: string, ipv4?: string) {
  const server = await startTestDnsServer(mode, ipv4);
  onTestFinished(() => server.close());
  const child = spawn(process.execPath, ["--import", "tsx", fixture], {
    env: { ...process.env, HF_TEST_DNS: server.address, HF_TEST_SYSTEM: system },
    stdio: ["ignore", "pipe", "inherit"],
  });
  onTestFinished(() => void child.kill("SIGKILL"));
  let printed = "";
  let printedAt = 0;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    printed += chunk;
    if (printedAt) return;
    printedAt = Date.now();
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  });
  await new Promise((resolve) => child.once("exit", resolve));
  return { printed: printed.trim(), livedOnMs: Date.now() - printedAt };
}

it("gives up when neither DNS nor the system lookup answers, and the process is gone right after", async () => {
  const run = await resolveInChild("silent", "stall");
  expect(run.printed).toBe("Capture DNS timed out");
  expect(run.livedOnMs).toBeLessThan(1_000);
}, 30_000);

it("falls back to the system answer when DNS gives none", async () => {
  const run = await resolveInChild("silent", "8.8.4.4");
  expect(run.printed).toBe("8.8.4.4");
  expect(run.livedOnMs).toBeLessThan(1_000);
}, 30_000);

it("uses the DNS answer without asking the system", async () => {
  const run = await resolveInChild("answer", "8.8.4.4", "93.184.216.34");
  expect(run.printed).toBe("93.184.216.34");
  expect(run.livedOnMs).toBeLessThan(1_000);
}, 30_000);
