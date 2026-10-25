import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix, resolve, sep } from "node:path";
import { defineCommand } from "citty";
import { safeFetch } from "../capture/assetDownloader.js";
import { readBoundedResponse } from "../capture/readBoundedResponse.js";
import type { Example } from "./_examples.js";
import type { LedgerAssetKind } from "@hyperframes/core/asset-ledger";
import { setCommandExitCode } from "../utils/commandResult.js";
import { c } from "../ui/colors.js";
import { resolveProject } from "../utils/project.js";
import { withMeta } from "../utils/updateCheck.js";

export const examples: Example[] = [
  ["Download remote assets and rewrite references", "hyperframes vendor"],
  ["Vendor into a custom directory", "hyperframes vendor ./my-video --out assets/third-party"],
  ["Preview what would be downloaded", "hyperframes vendor --dry-run"],
  ["Fail unless the project ends up fully offline", "hyperframes vendor --strict-offline"],
];

/** Only these URL schemes are ever fetched. Everything else stays remote. */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** Per-download size cap unless --max-bytes overrides it. */
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Kinds worth downloading. A remote iframe is a live page, not a static
 * asset — vendoring cannot make it deterministic, so it is left in place
 * (and still fails --strict-offline, which is the point).
 */
const VENDORABLE_KINDS = new Set<LedgerAssetKind>([
  "script",
  "stylesheet",
  "font",
  "image",
  "audio",
  "video",
  "track",
]);

const CONTENT_TYPE_EXT: Record<string, string> = {
  "text/javascript": ".js",
  "application/javascript": ".js",
  "text/css": ".css",
  "font/woff2": ".woff2",
  "font/woff": ".woff",
  "font/ttf": ".ttf",
  "font/otf": ".otf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/ogg": ".ogg",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "text/vtt": ".vtt",
  "application/json": ".json",
};

interface VendoredEntry {
  url: string;
  /** Project-root-relative path of the downloaded file (posix separators). */
  file: string;
  bytes: number;
  sha256: string;
  contentType?: string;
}

interface FailedDownload {
  url: string;
  error: string;
}

/** Normalize a declared remote URL to something fetchable, or null. */
export function toFetchableUrl(url: string): string | null {
  // Protocol-relative URLs default to https — the only sane offline-prep choice.
  const absolute = url.startsWith("//") ? `https:${url}` : url;
  try {
    const parsed = new URL(absolute);
    return ALLOWED_PROTOCOLS.has(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Stable, collision-free local filename for one remote URL. */
export function vendorFileName(url: string, contentType?: string): string {
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 10);
  let base = "asset";
  let ext = "";
  try {
    const pathname = new URL(url).pathname;
    const last = pathname.split("/").filter(Boolean).pop() ?? "";
    const dot = last.lastIndexOf(".");
    if (dot > 0) {
      base = last.slice(0, dot);
      ext = last.slice(dot);
    } else if (last) {
      base = last;
    }
  } catch {
    /* keep defaults */
  }
  if (!ext && contentType) {
    const normalized = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    ext = CONTENT_TYPE_EXT[normalized] ?? "";
  }
  const safeBase = base.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[.-]+/, "") || "asset";
  const safeExt = /^\.[a-zA-Z0-9]{1,8}$/.test(ext) ? ext.toLowerCase() : "";
  return `${safeBase}-${hash}${safeExt}`;
}

/**
 * Resolve a vendor file target and refuse anything that would escape the
 * vendor directory (defense in depth — `vendorFileName` already sanitizes).
 */
export function resolveVendorTarget(outDir: string, fileName: string): string {
  const base = resolve(outDir);
  const target = resolve(base, fileName);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`refusing to write outside the vendor directory: ${fileName}`);
  }
  return target;
}

async function downloadAsset(
  url: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<{ body: Buffer; contentType?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await safeFetch(url, { signal: controller.signal });
    if (!response) throw new Error("download refused: non-public URL or redirect");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await readBoundedResponse(response, maxBytes);
    if (!body) throw new Error(`asset exceeds size cap (${maxBytes} bytes) or has no body`);
    const contentType = response.headers.get("content-type") ?? undefined;
    return { body, ...(contentType !== undefined ? { contentType } : {}) };
  } finally {
    clearTimeout(timer);
  }
}

interface ReferenceSpan {
  /** Decoded URL, the key vendored downloads are stored under. */
  url: string;
  start: number;
  end: number;
}

/**
 * Replace exactly the declared reference spans whose URL was vendored with a
 * path relative to `file`. Other text, including a longer URL that merely
 * starts with a vendored one, is never touched.
 */
export function rewriteFileReferences(
  text: string,
  file: string,
  refs: ReadonlyArray<ReferenceSpan>,
  vendorPathByUrl: ReadonlyMap<string, string>,
): { text: string; rewritten: number } {
  const fileDir = posix.dirname(file);
  let out = "";
  let cursor = 0;
  let rewritten = 0;
  for (const ref of [...refs].sort((a, b) => a.start - b.start)) {
    const vendorPath = vendorPathByUrl.get(ref.url);
    if (!vendorPath || ref.start < cursor) continue;
    const relative = posix.relative(fileDir === "." ? "" : fileDir, vendorPath) || vendorPath;
    out += text.slice(cursor, ref.start) + relative;
    cursor = ref.end;
    rewritten++;
  }
  return { text: out + text.slice(cursor), rewritten };
}

/** A stylesheet that loads anything itself would break once moved under the vendor directory. */
function stylesheetLoadsDependencies(body: Buffer): boolean {
  return /url\s*\(|@import|\\/i.test(body.toString("utf-8"));
}

function isVendoredEntry(value: unknown): value is VendoredEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>; // narrowed via the checks below
  return (
    typeof entry.url === "string" &&
    typeof entry.file === "string" &&
    typeof entry.bytes === "number" &&
    typeof entry.sha256 === "string"
  );
}

/** Entries from a previous manifest on disk, or empty when absent/malformed. */
function readPreviousManifestEntries(manifestPath: string): VendoredEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return [];
    const assets = (parsed as Record<string, unknown>).assets; // narrowed below
    if (!Array.isArray(assets)) return [];
    return assets.filter(isVendoredEntry);
  } catch {
    return [];
  }
}

export default defineCommand({
  meta: {
    name: "vendor",
    description: "Download remote assets locally and rewrite references for offline renders",
  },
  args: {
    dir: {
      type: "positional",
      description: "Project directory",
      required: false,
    },
    out: {
      type: "string",
      alias: "o",
      description: "Directory (project-relative) to download assets into",
      default: "assets/vendor",
    },
    json: {
      type: "boolean",
      description: "Output the vendoring report as JSON",
      default: false,
    },
    "dry-run": {
      type: "boolean",
      description: "List what would be downloaded without writing anything",
      default: false,
    },
    "strict-offline": {
      type: "boolean",
      description: "Exit non-zero when any remote reference remains after vendoring",
      default: false,
    },
    timeout: {
      type: "string",
      description: "Per-download timeout in ms (default: 30000)",
      default: "30000",
    },
    "max-bytes": {
      type: "string",
      description: "Per-download size cap in bytes (default: 104857600 = 100 MB)",
      default: String(DEFAULT_MAX_BYTES),
    },
  },
  // fallow-ignore-next-line complexity
  async run({ args }) {
    const strictOffline = Boolean(args["strict-offline"]);
    const dryRun = Boolean(args["dry-run"]);
    const timeoutMs = Number.parseInt(String(args.timeout), 10) || 30000;
    const maxBytes = Number.parseInt(String(args["max-bytes"]), 10) || DEFAULT_MAX_BYTES;
    try {
      const project = resolveProject(args.dir, { requireIndex: false });
      const { buildProjectAssetLedger, extractFileAssetRefs } =
        await import("@hyperframes/core/asset-ledger");
      const ledger = buildProjectAssetLedger(project.dir);

      const outRel = String(args.out ?? "assets/vendor").replace(/\\/g, "/");
      const projectRoot = resolve(project.dir);
      const outDir = resolve(projectRoot, outRel);
      if (outDir !== projectRoot && !outDir.startsWith(projectRoot + sep)) {
        throw new Error(`--out must stay inside the project directory (got "${outRel}")`);
      }

      // Unique fetchable URLs, keyed by DECODED url; remember raw forms per file.
      const candidates = new Map<string, string>();
      for (const asset of ledger.assets) {
        if (asset.status !== "remote" || !VENDORABLE_KINDS.has(asset.kind)) continue;
        if (!candidates.has(asset.url)) {
          const fetchable = toFetchableUrl(asset.url);
          if (fetchable) candidates.set(asset.url, fetchable);
        }
      }

      if (dryRun) {
        const urls = [...candidates.keys()].sort();
        if (args.json) {
          console.log(
            JSON.stringify(withMeta({ ok: true, dryRun: true, wouldDownload: urls }), null, 2),
          );
        } else {
          console.log(`${c.accent("◆")}  Would download ${urls.length} remote asset(s):`);
          for (const url of urls) console.log(`   ${url}`);
        }
        setCommandExitCode(0);
        return;
      }

      const vendored: VendoredEntry[] = [];
      const failed: FailedDownload[] = [];
      const vendorPathByUrl = new Map<string, string>();

      if (candidates.size > 0) mkdirSync(outDir, { recursive: true });
      for (const [declaredUrl, fetchUrl] of candidates) {
        try {
          const { body, contentType } = await downloadAsset(fetchUrl, timeoutMs, maxBytes);
          const stylesheet =
            contentType?.toLowerCase().includes("text/css") ||
            ledger.assets.some((a) => a.url === declaredUrl && a.kind === "stylesheet");
          if (stylesheet && stylesheetLoadsDependencies(body)) {
            throw new Error(
              "stylesheet loads url(), @import or escaped dependencies that would break once vendored; keeping the remote reference",
            );
          }
          const fileName = vendorFileName(fetchUrl, contentType);
          const vendorPath = posix.join(outRel, fileName);
          // Network→file is this command's entire purpose (download remote
          // assets so renders run offline), so a CodeQL network-to-file-write
          // finding here is expected. Guards: http(s)-only scheme allowlist +
          // URL validation (toFetchableUrl), sanitized hash-suffixed filenames
          // (vendorFileName), a traversal check pinning every write under the
          // vendor directory (resolveVendorTarget, with outDir itself pinned
          // under the project root), and a per-download size cap.
          writeFileSync(resolveVendorTarget(outDir, fileName), body);
          vendorPathByUrl.set(declaredUrl, vendorPath);
          vendored.push({
            url: declaredUrl,
            file: vendorPath,
            bytes: body.length,
            sha256: createHash("sha256").update(body).digest("hex"),
            ...(contentType !== undefined ? { contentType } : {}),
          });
          if (!args.json) console.log(`${c.success("↓")}  ${declaredUrl} → ${vendorPath}`);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          failed.push({ url: declaredUrl, error: message });
          if (!args.json) console.error(`${c.error("✖")}  ${declaredUrl} — ${message}`);
        }
      }

      // Rewrite each scanned file's declared references to the vendored copies.
      let totalRewritten = 0;
      for (const file of vendorPathByUrl.size > 0 ? ledger.files : []) {
        const absolute = join(project.dir, file);
        const source = readFileSync(absolute, "utf-8");
        const refs = extractFileAssetRefs(file, source).filter((ref) =>
          VENDORABLE_KINDS.has(ref.kind),
        );
        const { text, rewritten } = rewriteFileReferences(source, file, refs, vendorPathByUrl);
        if (rewritten > 0) {
          writeFileSync(absolute, text);
          totalRewritten += rewritten;
        }
      }

      // Persist a provenance manifest next to the downloads (merged over any
      // previous run, keyed by URL, sorted for stable diffs).
      if (vendored.length > 0) {
        const manifestPath = join(outDir, "vendor-manifest.json");
        const byUrl = new Map<string, VendoredEntry>();
        for (const entry of readPreviousManifestEntries(manifestPath)) byUrl.set(entry.url, entry);
        for (const entry of vendored) byUrl.set(entry.url, entry);
        const manifest = {
          version: 1,
          assets: [...byUrl.values()].sort((a, b) => a.url.localeCompare(b.url)),
        };
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      }

      const after = buildProjectAssetLedger(project.dir);
      const remaining = after.remoteUrls;
      const strictViolation = strictOffline && remaining.length > 0;
      const ok = failed.length === 0 && !strictViolation;

      if (args.json) {
        console.log(
          JSON.stringify(
            withMeta({
              ok,
              strictOffline,
              out: outRel,
              downloaded: vendored,
              failed,
              rewrittenReferences: totalRewritten,
              remainingRemoteUrls: remaining,
              counts: after.counts,
            }),
            null,
            2,
          ),
        );
        setCommandExitCode(ok ? 0 : 1);
        return;
      }

      console.log();
      console.log(
        `${c.accent("◆")}  Vendored ${vendored.length} asset(s) into ${outRel}, ` +
          `rewrote ${totalRewritten} reference(s).`,
      );
      if (failed.length > 0) {
        console.log(c.error(`   ${failed.length} download(s) failed.`));
      }
      if (remaining.length > 0) {
        console.log(c.warn(`   ${remaining.length} remote reference(s) remain:`));
        for (const url of remaining) console.log(`   ${c.warn("•")} ${url}`);
      } else {
        console.log(c.success("   0 remote references remain — project renders offline."));
      }
      if (strictViolation) {
        console.log();
        console.log(c.error("✖  --strict-offline: remote references remain."));
      }
      setCommandExitCode(ok ? 0 : 1);
      return;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (args.json) {
        console.log(JSON.stringify(withMeta({ ok: false, error: message }), null, 2));
      } else {
        console.error(message);
      }
      setCommandExitCode(1);
    }
  },
});
