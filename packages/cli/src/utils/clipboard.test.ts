import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", async (orig) => ({
  ...(await orig<typeof import("node:os")>()),
  platform: () => "linux",
}));

describe.skipIf(process.platform === "win32")("copyToClipboard", () => {
  const oldPath = process.env.PATH;
  let dir = "";
  afterEach(() => {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("returns when the clipboard tool leaves a background owner running", async () => {
    dir = mkdtempSync(join(tmpdir(), "hf-clip-"));
    const tool = join(dir, "clip.exe");
    writeFileSync(tool, "#!/bin/sh\ncat >/dev/null\nsleep 8 &\nexit 0\n");
    chmodSync(tool, 0o755);
    process.env.PATH = `${dir}:${oldPath}`;
    const { copyToClipboard } = await import("./clipboard.js");
    const start = Date.now();
    expect(copyToClipboard("snippet")).toBe(true);
    expect(Date.now() - start).toBeLessThan(4000);
  });
});
