import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  Browser,
  Cache,
  computeExecutablePath,
  detectBrowserPlatform,
  install,
} from "@puppeteer/browsers";
import AdmZip from "adm-zip";
import { afterEach, expect, it, vi } from "vitest";
import { unzipArchive } from "./unzipArchive.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

// Windows unzips with tar.exe by absolute path, so an empty PATH only hides `unzip` elsewhere.
it.skipIf(process.platform === "win32")(
  "unpacks the browser download on a machine without an unzip command",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "hf-unzip-fallback-"));
    const platform = detectBrowserPlatform();
    if (!platform) throw new Error("unsupported test platform");
    const cacheDir = join(root, "cache");
    const options = { cacheDir, browser: Browser.CHROMEHEADLESSSHELL, buildId: "1.0.0", platform };
    const executablePath = computeExecutablePath(options);
    const archive = new AdmZip();
    archive.addFile(
      relative(join(cacheDir, Browser.CHROMEHEADLESSSHELL, `${platform}-1.0.0`), executablePath),
      Buffer.from("browser"),
    );
    const zipBytes = archive.toBuffer();
    const server = createServer((_request, response) => response.end(zipBytes));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    vi.stubEnv("PATH", join(root, "empty-bin"));
    try {
      const { port } = server.address() as AddressInfo;

      await install({ ...options, baseUrl: `http://127.0.0.1:${port}` });

      expect(existsSync(executablePath)).toBe(true);
    } finally {
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "unzips the download itself, and install() then finds the browser and drops the archive",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "hf-unzip-own-"));
    const platform = detectBrowserPlatform();
    if (!platform) throw new Error("unsupported test platform");
    const cacheDir = join(root, "cache");
    const options = { cacheDir, browser: Browser.CHROMEHEADLESSSHELL, buildId: "1.0.0", platform };
    const executablePath = computeExecutablePath(options);
    const into = new Cache(cacheDir).installationDir(options.browser, platform, options.buildId);
    const archive = new AdmZip();
    archive.addFile(relative(into, executablePath), Buffer.from("browser"));
    const zipBytes = archive.toBuffer();
    const server = createServer((_request, response) => response.end(zipBytes));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      const archivePath = await install({ ...options, baseUrl, unpack: false });
      expect(await unzipArchive(archivePath, into)).toBe(true);
      expect(existsSync(executablePath)).toBe(true);
      const installed = await install({ ...options, baseUrl });

      expect(installed.executablePath).toBe(executablePath);
      expect(existsSync(archivePath)).toBe(false);
    } finally {
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "a full disk fails the unzip at once instead of waiting on its Continue? question",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "hf-unzip-full-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    // What unzip does on a write error: ask, wait for an answer on its input, then give up.
    writeFileSync(
      join(bin, "unzip"),
      "#!/bin/sh\nprintf 'write error (disk full?).  Continue? (y/n/^C) ' >&2\nread answer\nexit 50\n",
    );
    chmodSync(join(bin, "unzip"), 0o755);
    vi.stubEnv("PATH", `${bin}:/usr/bin:/bin`);
    try {
      await expect(unzipArchive(join(root, "a.zip"), join(root, "out"))).rejects.toThrow(
        "Extraction failed: write error (disk full?)",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  5_000,
);

it.skipIf(process.platform === "win32")(
  "says there is no unzip command, so install() unpacks it itself",
  async () => {
    vi.stubEnv("PATH", join(tmpdir(), "hf-no-such-bin"));
    expect(await unzipArchive("a.zip", "out")).toBe(false);
  },
);
