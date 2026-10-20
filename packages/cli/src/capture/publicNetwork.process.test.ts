import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";
import { startTestDnsServer } from "../utils/dnsTestServer.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "publicNetwork.fixture.ts");

/** What the fixture printed, and how long its process lived after printing it. */
async function resolveInChild(mode: "silent" | "answer", ipv4?: string) {
  const server = await startTestDnsServer(mode, ipv4);
  onTestFinished(() => server.close());
  const child = spawn(process.execPath, ["--import", "tsx", fixture], {
    env: { ...process.env, HF_TEST_DNS: server.address },
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

it("gives up on a DNS server that never answers, and nothing it started keeps the process alive", async () => {
  const run = await resolveInChild("silent");
  expect(run.printed).toBe("Capture DNS timed out");
  expect(run.livedOnMs).toBeLessThan(2_000);
}, 30_000);

it("answers with the server's public address and exits right after", async () => {
  const run = await resolveInChild("answer", "93.184.216.34");
  expect(run.printed).toBe("93.184.216.34");
  expect(run.livedOnMs).toBeLessThan(2_000);
}, 30_000);
