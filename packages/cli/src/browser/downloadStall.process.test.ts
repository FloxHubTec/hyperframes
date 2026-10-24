import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "downloadStall.fixture.ts");
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

it("exits with code 1 when the download host accepts the connection and never answers", async () => {
  const sockets: Socket[] = [];
  const server = createServer((socket) => sockets.push(socket));
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address() as { port: number };
  const home = mkdtempSync(join(tmpdir(), "hf-download-stall-"));
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fixturePath, `http://127.0.0.1:${port}`],
    {
      env: { ...process.env, HOME: home, USERPROFILE: home, HYPERFRAMES_BROWSER_PATH: "" },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  cleanups.push(() => {
    child.kill("SIGKILL");
    for (const socket of sockets) socket.destroy();
    server.close();
    rmSync(home, { recursive: true, force: true });
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));

  const exit = await new Promise<{ code: number | null }>((resolve) => {
    const giveUp = setTimeout(() => resolve({ code: null }), 20_000);
    child.once("exit", (code) => {
      clearTimeout(giveUp);
      resolve({ code });
    });
  });

  expect(exit.code).toBe(1);
  expect(stderr).toContain(`The Chrome download from 127.0.0.1:${port} stalled`);
}, 30_000);
