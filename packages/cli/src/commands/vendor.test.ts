import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractFileAssetRefs } from "../utils/assetLedger.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consumeCommandResult } from "../utils/commandResult.js";
import {
  GSAP_URL,
  lastJsonOutput,
  makeFixtureProject,
  makeRunner,
  spyOnConsole,
} from "./_offlineAssetsTestKit.js";

// withMeta just annotates the object; identity keeps the assertions simple.
vi.mock("../utils/updateCheck.js", () => ({ withMeta: (o: unknown) => o }));
// resolveProject reports invalid-dir failures to telemetry; keep tests silent.
vi.mock("../telemetry/events.js", () => ({ trackCommandFailure: () => {} }));
// Every download must go through capture's pinned public transport.
const { publicRequest } = vi.hoisted(() => ({
  publicRequest: vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>(),
}));
vi.mock("../capture/publicNetwork.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../capture/publicNetwork.js")>()),
  publicRequest,
}));

import vendorCommand, {
  resolveVendorTarget,
  rewriteFileReferences,
  scriptLoadsDependencies,
  stylesheetLoadsDependencies,
  toFetchableUrl,
  vendorFileName,
} from "./vendor.js";

const run = makeRunner(vendorCommand);

function fetchResponse(body: string, contentType: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

describe("toFetchableUrl", () => {
  it("allows http(s) and upgrades protocol-relative URLs to https", () => {
    expect(toFetchableUrl(GSAP_URL)).toBe(GSAP_URL);
    expect(toFetchableUrl("http://example.com/a.js")).toBe("http://example.com/a.js");
    expect(toFetchableUrl("//cdn.example.com/a.js")).toBe("https://cdn.example.com/a.js");
  });

  it("rejects non-http(s) schemes", () => {
    expect(toFetchableUrl("ftp://example.com/a.png")).toBeNull();
    expect(toFetchableUrl("file:///etc/passwd")).toBeNull();
    expect(toFetchableUrl("not a url")).toBeNull();
  });
});

describe("vendorFileName", () => {
  it("keeps the basename, appends a stable hash, and preserves the extension", () => {
    const name = vendorFileName(GSAP_URL);
    expect(name).toMatch(/^gsap\.min-[0-9a-f]{10}\.js$/);
    expect(vendorFileName(GSAP_URL)).toBe(name);
  });

  it("derives the extension from content-type when the URL has none", () => {
    expect(vendorFileName("https://fonts.example.com/inter", "font/woff2")).toMatch(/\.woff2$/);
  });
});

describe("resolveVendorTarget", () => {
  it("resolves plain filenames under the vendor directory", () => {
    const outDir = join("/tmp", "proj", "assets", "vendor");
    expect(resolveVendorTarget(outDir, "gsap.min-abc.js")).toBe(resolve(outDir, "gsap.min-abc.js"));
  });

  it("refuses filenames that would escape the vendor directory", () => {
    const outDir = join("/tmp", "proj", "assets", "vendor");
    expect(() => resolveVendorTarget(outDir, "../../../etc/passwd")).toThrow(
      /outside the vendor directory/,
    );
    expect(() => resolveVendorTarget(outDir, "/etc/passwd")).toThrow(
      /outside the vendor directory/,
    );
  });
});

describe("rewriteFileReferences", () => {
  const rewrite = (text: string, file: string, vendored: Record<string, string>) =>
    rewriteFileReferences(
      text,
      file,
      extractFileAssetRefs(file, text),
      new Map(Object.entries(vendored)),
    );

  it("leaves a longer URL that starts with a vendored one untouched", () => {
    const html = '<link rel="stylesheet" href="https://x.com/a.css?v=2">';
    expect(rewrite(html, "index.html", { "https://x.com/a.css": "v/a.css" })).toEqual({
      text: html,
      rewritten: 0,
    });
  });

  it("rewrites only declared references, not the same URL in prose or script text", () => {
    const html = `<script src="${GSAP_URL}"></script><p>${GSAP_URL}</p><script>load("${GSAP_URL}")</script>`;
    const { text, rewritten } = rewrite(html, "index.html", { [GSAP_URL]: "v/gsap.js" });
    expect(rewritten).toBe(1);
    expect(text).toBe(
      `<script src="v/gsap.js"></script><p>${GSAP_URL}</p><script>load("${GSAP_URL}")</script>`,
    );
  });

  it("rewrites to a path relative to the referencing file", () => {
    const html = `<script src="${GSAP_URL}"></script>`;
    const vendored = { [GSAP_URL]: "assets/vendor/gsap.min-abc.js" };
    const fromRoot = rewrite(html, "index.html", vendored);
    expect(fromRoot.rewritten).toBe(1);
    expect(fromRoot.text).toContain('src="assets/vendor/gsap.min-abc.js"');
    expect(rewrite(html, "scenes/intro.html", vendored).text).toContain(
      'src="../assets/vendor/gsap.min-abc.js"',
    );
  });

  it("matches entity-encoded references by their decoded URL", () => {
    const html = '<script src="https://x.com/a.js?v=1&amp;b=2"></script>';
    const { text } = rewrite(html, "index.html", { "https://x.com/a.js?v=1&b=2": "v/a.js" });
    expect(text).toBe('<script src="v/a.js"></script>');
  });

  it("rewrites url() references in a local stylesheet relative to that stylesheet", () => {
    const css = `.a { background: url("https://x.com/bg.png"); }`;
    const { text } = rewrite(css, "styles/theme.css", {
      "https://x.com/bg.png": "assets/vendor/bg.png",
    });
    expect(text).toBe(`.a { background: url("../assets/vendor/bg.png"); }`);
  });
});

describe("stylesheetLoadsDependencies", () => {
  it("flags relative url(), @import and escaped identifiers", () => {
    expect(stylesheetLoadsDependencies("@font-face{src:url(../webfonts/fa.woff2)}")).toBe(true);
    expect(stylesheetLoadsDependencies('@import "theme.css";')).toBe(true);
    expect(stylesheetLoadsDependencies(".a{background:u\\72l(x.png)}")).toBe(true);
  });

  it("allows data: URLs, absolute URLs and escapes inside strings", () => {
    const css = `.a{background:url("data:image/svg+xml,%3csvg%3e%3c/svg%3e")}.b::before{content:"\\2014 \\00A0"}@import url("https://x.com/b.css");`;
    expect(stylesheetLoadsDependencies(css)).toBe(false);
  });
});

describe("scriptLoadsDependencies", () => {
  it("flags static, re-exported and dynamic imports and import.meta", () => {
    expect(scriptLoadsDependencies('import{REVISION as e}from"./three.core.js";')).toBe(true);
    expect(scriptLoadsDependencies('export*from"/npm/d3-array@3.2.4/+esm";')).toBe(true);
    expect(scriptLoadsDependencies('const m = await import("./chunk.js");')).toBe(true);
    expect(scriptLoadsDependencies('new URL("./w.wasm", import.meta.url)')).toBe(true);
  });

  it("allows classic scripts and self-contained modules", () => {
    expect(scriptLoadsDependencies('!function(t){t.gsap={import:1,a:x.import("y")}}(this)')).toBe(
      false,
    );
    expect(scriptLoadsDependencies("export const a = 1; export default a;")).toBe(false);
  });
});

describe("vendor command", () => {
  let dir: string;

  beforeEach(() => {
    consumeCommandResult();
    spyOnConsole();
    dir = makeFixtureProject("hf-vendor-cmd-");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    publicRequest.mockReset();
    consumeCommandResult();
    rmSync(dir, { recursive: true, force: true });
  });

  it("downloads remotes, rewrites HTML, and writes the manifest", async () => {
    publicRequest.mockImplementation(async () => fetchResponse("/* gsap */", "text/javascript"));

    await run({ dir, out: "assets/vendor", json: true, "strict-offline": true });
    expect(consumeCommandResult().exitCode).toBe(0);

    const output = lastJsonOutput();
    expect(output.ok).toBe(true);
    expect(output.remainingRemoteUrls).toEqual([]);
    expect(output.rewrittenReferences).toBe(1);
    expect(publicRequest).toHaveBeenCalledWith(GSAP_URL, expect.anything());

    const html = readFileSync(join(dir, "index.html"), "utf-8");
    expect(html).not.toContain("https://");
    expect(html).toMatch(/src="assets\/vendor\/gsap\.min-[0-9a-f]{10}\.js"/);

    const vendorFiles = readdirSync(join(dir, "assets", "vendor"));
    expect(vendorFiles).toContain("vendor-manifest.json");
    expect(vendorFiles.some((f) => f.startsWith("gsap.min-"))).toBe(true);

    const manifest = JSON.parse(
      readFileSync(join(dir, "assets", "vendor", "vendor-manifest.json"), "utf-8"),
    );
    expect(manifest.assets).toHaveLength(1);
    expect(manifest.assets[0]).toMatchObject({ url: GSAP_URL, bytes: 10 });
    expect(manifest.assets[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("--dry-run lists candidate downloads without touching the project", async () => {
    await run({ dir, out: "assets/vendor", json: true, "dry-run": true });
    expect(consumeCommandResult().exitCode).toBe(0);
    expect(publicRequest).not.toHaveBeenCalled();
    expect(lastJsonOutput().wouldDownload).toEqual([GSAP_URL]);
    expect(existsSync(join(dir, "assets", "vendor"))).toBe(false);
    expect(readFileSync(join(dir, "index.html"), "utf-8")).toContain(GSAP_URL);
  });

  it("reports failed downloads and exits 1 without rewriting their references", async () => {
    publicRequest.mockImplementation(async () => new Response("nope", { status: 404 }));

    await run({ dir, out: "assets/vendor", json: true });
    expect(consumeCommandResult().exitCode).toBe(1);

    const output = lastJsonOutput();
    expect(output.ok).toBe(false);
    expect(output.failed).toEqual([{ url: GSAP_URL, error: "HTTP 404" }]);
    expect(readFileSync(join(dir, "index.html"), "utf-8")).toContain(GSAP_URL);
  });

  it("rejects downloads over the size cap without rewriting their references", async () => {
    publicRequest.mockImplementation(async () => fetchResponse("0123456789", "text/javascript"));

    await run({ dir, out: "assets/vendor", json: true, "max-bytes": "4" });
    expect(consumeCommandResult().exitCode).toBe(1);

    const output = lastJsonOutput();
    expect(output.ok).toBe(false);
    expect(output.failed).toEqual([
      { url: GSAP_URL, error: expect.stringMatching(/exceeds size cap/) },
    ]);
    expect(readFileSync(join(dir, "index.html"), "utf-8")).toContain(GSAP_URL);
  });

  it("refuses an --out directory outside the project", async () => {
    await run({ dir, out: "../outside-vendor", json: true });
    expect(consumeCommandResult().exitCode).toBe(1);
    expect(publicRequest).not.toHaveBeenCalled();
    expect(lastJsonOutput().error).toMatch(/inside the project directory/);
  });

  it("enforces the size cap while streaming a body with no content-length", async () => {
    let pulls = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    publicRequest.mockImplementation(
      async () =>
        new Response(endless, { status: 200, headers: { "content-type": "text/javascript" } }),
    );

    await run({ dir, out: "assets/vendor", json: true, "max-bytes": "4096" });
    expect(consumeCommandResult().exitCode).toBe(1);
    expect(lastJsonOutput().failed).toEqual([
      { url: GSAP_URL, error: expect.stringMatching(/exceeds size cap/) },
    ]);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(8);
    expect(existsSync(join(dir, "assets", "vendor", "vendor-manifest.json"))).toBe(false);
  });

  it("refuses private addresses without making a request", async () => {
    writeFileSync(join(dir, "index.html"), `<script src="http://169.254.169.254/x.js"></script>`);

    await run({ dir, out: "assets/vendor", json: true });
    expect(consumeCommandResult().exitCode).toBe(1);
    expect(publicRequest).not.toHaveBeenCalled();
    expect(lastJsonOutput().failed).toEqual([
      { url: "http://169.254.169.254/x.js", error: expect.stringMatching(/refused/) },
    ]);
  });

  it("refuses a redirect to a private address", async () => {
    publicRequest.mockImplementation(
      async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/x" } }),
    );

    await run({ dir, out: "assets/vendor", json: true });
    expect(consumeCommandResult().exitCode).toBe(1);
    expect(publicRequest).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(dir, "index.html"), "utf-8")).toContain(GSAP_URL);
  });

  it("keeps a stylesheet remote when it loads its own dependencies", async () => {
    const cssUrl = "https://cdn.example.com/fa/all.min.css";
    writeFileSync(join(dir, "index.html"), `<link rel="stylesheet" href="${cssUrl}">`);
    publicRequest.mockImplementation(async () =>
      fetchResponse(`@font-face { src: url(../webfonts/fa.woff2); }`, "text/css"),
    );

    await run({ dir, out: "assets/vendor", json: true, "strict-offline": true });
    expect(consumeCommandResult().exitCode).toBe(1);
    const output = lastJsonOutput();
    expect(output.failed).toEqual([{ url: cssUrl, error: expect.stringMatching(/stylesheet/) }]);
    expect(output.remainingRemoteUrls).toEqual([cssUrl]);
    expect(readFileSync(join(dir, "index.html"), "utf-8")).toContain(cssUrl);
  });

  it("vendors remote url() references in local stylesheets and gates on them", async () => {
    const fontUrl = "https://fonts.example.com/inter.woff2";
    mkdirSync(join(dir, "styles"));
    writeFileSync(join(dir, "styles", "theme.css"), `@font-face { src: url("${fontUrl}"); }`);
    publicRequest.mockImplementation(async () => fetchResponse("font", "font/woff2"));

    await run({ dir, out: "assets/vendor", json: true, "strict-offline": true });
    expect(consumeCommandResult().exitCode).toBe(0);
    expect(lastJsonOutput().remainingRemoteUrls).toEqual([]);
    expect(readFileSync(join(dir, "styles", "theme.css"), "utf-8")).toMatch(
      /url\("\.\.\/assets\/vendor\/inter-[0-9a-f]{10}\.woff2"\)/,
    );
  });

  it("keeps an ES module script remote when it imports other files", async () => {
    const moduleUrl = "https://cdn.example.com/three/build/three.module.js";
    writeFileSync(join(dir, "index.html"), `<script type="module" src="${moduleUrl}"></script>`);
    publicRequest.mockImplementation(async () =>
      fetchResponse('import{REVISION as e}from"./three.core.js";export{e};', "text/javascript"),
    );

    await run({ dir, out: "assets/vendor", json: true, "strict-offline": true });
    expect(consumeCommandResult().exitCode).toBe(1);
    const output = lastJsonOutput();
    expect(output.failed).toEqual([{ url: moduleUrl, error: expect.stringMatching(/imports/) }]);
    expect(output.remainingRemoteUrls).toEqual([moduleUrl]);
    expect(readFileSync(join(dir, "index.html"), "utf-8")).toContain(moduleUrl);
  });

  it("vendors a stylesheet with data: URLs; a second run vendors its absolute url()", async () => {
    const cssUrl = "https://cdn.example.com/bootstrap.min.css";
    const bgUrl = "https://cdn.example.com/bg.png";
    writeFileSync(join(dir, "index.html"), `<link rel="stylesheet" href="${cssUrl}">`);
    publicRequest.mockImplementation(async () =>
      fetchResponse(
        `.a{background:url("data:image/svg+xml,%3csvg%3e%3c/svg%3e")}.b{background:url(${bgUrl})}`,
        "text/css",
      ),
    );

    await run({ dir, out: "assets/vendor", json: true, "strict-offline": true });
    expect(consumeCommandResult().exitCode).toBe(1);
    const output = lastJsonOutput();
    expect(output.failed).toEqual([]);
    expect(output.remainingRemoteUrls).toEqual([bgUrl]);
    expect(readFileSync(join(dir, "index.html"), "utf-8")).not.toContain(cssUrl);

    publicRequest.mockImplementation(async () => fetchResponse("png", "image/png"));
    await run({ dir, out: "assets/vendor", json: true, "strict-offline": true });
    expect(consumeCommandResult().exitCode).toBe(0);
    expect(lastJsonOutput().remainingRemoteUrls).toEqual([]);
  });

  it("--strict-offline exits 1 when a non-vendorable remote (iframe) remains", async () => {
    writeFileSync(join(dir, "index.html"), `<iframe src="https://example.com/embed"></iframe>`);

    await run({ dir, out: "assets/vendor", json: true, "strict-offline": true });
    expect(consumeCommandResult().exitCode).toBe(1);

    const output = lastJsonOutput();
    expect(output.ok).toBe(false);
    expect(output.remainingRemoteUrls).toEqual(["https://example.com/embed"]);
  });
});
