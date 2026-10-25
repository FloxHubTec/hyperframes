// Scans HTML and CSS text only, so it runs without a browser or network.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  isUnresolvedAssetPlaceholder,
  maskNonScannableRanges,
  resolveExistingLocalAsset,
} from "@hyperframes/parsers/asset-resolution";

export type LedgerAssetKind =
  | "script"
  | "stylesheet"
  | "font"
  | "image"
  | "audio"
  | "video"
  | "iframe"
  | "track";

export type LedgerAssetStatus = "remote" | "local" | "data" | "missing";

/** Where in the markup a reference was declared. */
export type LedgerAssetVia =
  | "src"
  | "href"
  | "srcset"
  | "poster"
  | "css-url"
  | "css-import"
  | "style-attr";

export interface LedgerAssetRef {
  kind: LedgerAssetKind;
  /** Decoded URL (HTML entities like `&amp;` resolved) — what a fetch would use. */
  url: string;
  /** The URL exactly as written in the source, for text-level rewriting. */
  rawUrl: string;
  status: LedgerAssetStatus;
  /** Project-root-relative path of the HTML or CSS file holding the reference. */
  file: string;
  via: LedgerAssetVia;
  /** Project-root-relative path of the resolved file when status is `local`. */
  localPath?: string;
}

export interface AssetLedger {
  /** Project-root-relative HTML and CSS files that were scanned, in scan order. */
  files: string[];
  assets: LedgerAssetRef[];
  counts: { total: number } & Record<LedgerAssetStatus, number>;
  /** Deduped decoded remote URLs, in first-seen order. */
  remoteUrls: string[];
}

export interface LedgerFileInput {
  /** Project-root-relative path (used verbatim in findings). */
  file: string;
  html: string;
}

export interface BuildLedgerOptions {
  /** Resolves a local URL to a root-relative path, or null; without it every local URL is `missing`. */
  resolveLocalAsset?: (fromFile: string, url: string) => string | null;
}

interface ExtractedRef {
  kind: LedgerAssetKind;
  url: string;
  rawUrl: string;
  via: LedgerAssetVia;
  /** Source offsets of this one reference, so a rewrite never touches other text. */
  start: number;
  end: number;
}

/** Maps an index in the scanned text back to an offset in the source file. */
type OffsetMap = (index: number) => number;

// ── URL classification ──────────────────────────────────────────────────────

const REMOTE_URL_RE = /^(https?:)?\/\//i;
// Runtime-only or non-asset schemes: nothing on disk to resolve, nothing a
// vendor step could download deterministically.
const NON_ASSET_SCHEME_RE = /^(blob:|about:|javascript:|mailto:|tel:)/i;
const HAS_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Classify one declared URL. `local-candidate` means "looks like a path on
 * disk — resolve it to decide local vs missing"; `skip` means the value is not
 * an inventoriable asset (empty, fragment, runtime-only scheme, or an
 * unresolved templating placeholder a build step substitutes later).
 */
export function classifyAssetUrl(url: string): "remote" | "data" | "local-candidate" | "skip" {
  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith("#")) return "skip";
  if (isUnresolvedAssetPlaceholder(trimmed)) return "skip";
  if (/^data:/i.test(trimmed)) return "data";
  if (REMOTE_URL_RE.test(trimmed)) return "remote";
  if (NON_ASSET_SCHEME_RE.test(trimmed)) return "skip";
  // Any other scheme (ftp:, ws:, file:, …) is still a non-relative reference
  // that breaks a self-contained project — count it as remote so
  // --strict-offline surfaces it, even though vendoring only downloads http(s).
  if (HAS_SCHEME_RE.test(trimmed)) return "remote";
  return "local-candidate";
}

// ── HTML scanning ───────────────────────────────────────────────────────────

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
};

/**
 * Minimal entity decode for attribute values (URLs use a small entity set).
 * Single pass so each entity decodes exactly once — a decoded `&` can never
 * recombine with following text into a second entity (`&amp;lt;` → `&lt;`,
 * never `<`).
 */
function decodeHtmlEntities(value: string): string {
  return decodeHtmlEntitiesMapped(value).text;
}

/** Entity decode that also maps each decoded index back to its raw index. */
function decodeHtmlEntitiesMapped(value: string): { text: string; rawIndex: OffsetMap } {
  const starts: number[] = [];
  let text = "";
  let cursor = 0;
  for (const match of value.matchAll(/&(?:(amp|quot|apos|lt|gt)|#0*39);/gi)) {
    for (let i = cursor; i < match.index; i++) starts.push(i);
    text += value.slice(cursor, match.index);
    const name = match[1];
    text += name === undefined ? "'" : (HTML_ENTITY_MAP[name.toLowerCase()] ?? match[0]);
    starts.push(match.index);
    cursor = match.index + match[0].length;
  }
  for (let i = cursor; i < value.length; i++) starts.push(i);
  text += value.slice(cursor);
  return { text, rawIndex: (index) => starts[index] ?? value.length };
}

/** Length-preserving `<!-- … -->` blanking so commented-out tags never count. */
function maskHtmlComments(html: string): string {
  const chunks: string[] = [];
  let cursor = 0;
  while (true) {
    const start = html.indexOf("<!--", cursor);
    if (start === -1) break;
    const end = html.indexOf("-->", start + 4);
    if (end === -1) break;
    const afterComment = end + 3;
    chunks.push(html.slice(cursor, start), " ".repeat(afterComment - start));
    cursor = afterComment;
  }
  return chunks.length === 0 ? html : chunks.join("") + html.slice(cursor);
}

interface LocatedValue {
  value: string;
  /** Index of `value` inside the text it was read from. */
  start: number;
}

/** First defined capture group among `groups`, with its index. */
function firstGroup(match: RegExpExecArray, groups: number[]): LocatedValue | null {
  for (const group of groups) {
    const value = match[group];
    const span = match.indices?.[group];
    if (value !== undefined && span) return { value, start: span[0] };
  }
  return null;
}

/** Read one attribute value from a single already-delimited tag's source. */
function readTagAttr(tagSource: string, attr: string): LocatedValue | null {
  const re = new RegExp(`\\b${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "di");
  const match = re.exec(tagSource);
  return match ? firstGroup(match, [1, 2, 3]) : null;
}

/** Split a `srcset` value into its URL parts (descriptors dropped). */
function parseSrcset(value: string): LocatedValue[] {
  const urls: LocatedValue[] = [];
  let offset = 0;
  for (const entry of value.split(",")) {
    const lead = entry.length - entry.trimStart().length;
    const url = entry.trimStart().split(/\s+/, 1)[0];
    if (url) urls.push({ value: url, start: offset + lead });
    offset += entry.length + 1;
  }
  return urls;
}

const LINK_PRELOAD_AS_KIND: Record<string, LedgerAssetKind> = {
  font: "font",
  style: "stylesheet",
  script: "script",
  image: "image",
  audio: "audio",
  video: "video",
  track: "track",
};

function lowerAttr(tagSource: string, attr: string): string {
  return (readTagAttr(tagSource, attr)?.value ?? "").toLowerCase();
}

function linkKind(tagSource: string): LedgerAssetKind | null {
  const rel = lowerAttr(tagSource, "rel");
  const relParts = rel.split(/\s+/);
  if (relParts.includes("stylesheet")) return "stylesheet";
  if (relParts.includes("modulepreload")) return "script";
  if (relParts.includes("preload") || relParts.includes("prefetch")) {
    const as = lowerAttr(tagSource, "as");
    return LINK_PRELOAD_AS_KIND[as] ?? null;
  }
  if (relParts.some((part) => part === "icon" || part === "apple-touch-icon")) return "image";
  return null;
}

function pushRef(
  refs: ExtractedRef[],
  kind: LedgerAssetKind,
  located: LocatedValue | null,
  via: LedgerAssetVia,
  at: OffsetMap,
): void {
  if (!located) return;
  const trimmed = located.value.trim();
  if (!trimmed) return;
  const from = located.start + located.value.length - located.value.trimStart().length;
  refs.push({
    kind,
    url: decodeHtmlEntities(trimmed),
    rawUrl: trimmed,
    via,
    start: at(from),
    end: at(from + trimmed.length),
  });
}

/** Media elements whose nested `<source>` children inherit their kind. */
const SOURCE_PARENT_KIND: Record<string, LedgerAssetKind> = {
  video: "video",
  audio: "audio",
  picture: "image",
};

// fallow-ignore-next-line complexity
function collectTagRefs(html: string, refs: ExtractedRef[]): void {
  // Script/style BODIES are blanked (length-preserving) so markup inside a
  // string literal or template can't register as a real tag; the open tags of
  // scripts are re-scanned separately below because the mask removes them too.
  const scannable = maskNonScannableRanges(html);

  // Nearest enclosing <video>/<audio>/<picture>, so a nested <source> knows
  // which kind it feeds. Void/media tags are never nested inside each other
  // in valid markup, so a one-deep stack is enough.
  const parentStack: string[] = [];

  let cursor = 0;
  while (cursor < scannable.length) {
    const open = scannable.indexOf("<", cursor);
    if (open === -1) break;
    const close = scannable.indexOf(">", open + 1);
    if (close === -1) break;
    cursor = close + 1;

    const tagSource = scannable.slice(open, cursor);
    const at: OffsetMap = (index) => open + index;
    const attr = (kind: LedgerAssetKind, name: string, via: LedgerAssetVia) =>
      pushRef(refs, kind, readTagAttr(tagSource, name), via, at);
    const srcset = (kind: LedgerAssetKind) => {
      const value = readTagAttr(tagSource, "srcset");
      if (!value) return;
      for (const url of parseSrcset(value.value)) {
        pushRef(refs, kind, { value: url.value, start: value.start + url.start }, "srcset", at);
      }
    };
    const nameMatch = /^<\/?\s*([a-zA-Z][\w-]*)/.exec(tagSource);
    if (!nameMatch) continue;
    const name = (nameMatch[1] ?? "").toLowerCase();
    const isClosing = tagSource.startsWith("</");

    if (name in SOURCE_PARENT_KIND) {
      if (isClosing) {
        if (parentStack[parentStack.length - 1] === name) parentStack.pop();
        continue;
      }
      parentStack.push(name);
    }
    if (isClosing) continue;

    switch (name) {
      case "link": {
        const kind = linkKind(tagSource);
        if (kind) attr(kind, "href", "href");
        break;
      }
      case "img": {
        attr("image", "src", "src");
        srcset("image");
        break;
      }
      case "source": {
        const parent = parentStack[parentStack.length - 1] ?? "";
        srcset("image");
        attr(SOURCE_PARENT_KIND[parent] ?? "video", "src", "src");
        break;
      }
      case "video": {
        attr("video", "src", "src");
        attr("image", "poster", "poster");
        break;
      }
      case "audio":
      case "iframe":
      case "track":
        attr(name, "src", "src");
        break;
      default:
        break;
    }

    const styleAttr = readTagAttr(tagSource, "style");
    if (styleAttr) {
      const decoded = decodeHtmlEntitiesMapped(styleAttr.value);
      collectCssRefs(decoded.text, refs, "style-attr", (index) =>
        at(styleAttr.start + decoded.rawIndex(index)),
      );
    }
  }
}

/** `<script src>` open tags — masked out of the generic scan, so re-found here. */
function collectScriptRefs(html: string, refs: ExtractedRef[]): void {
  const scriptOpenRe = /<script\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptOpenRe.exec(html)) !== null) {
    const tagStart = match.index;
    pushRef(refs, "script", readTagAttr(match[0], "src"), "src", (index) => tagStart + index);
  }
}

// ── CSS scanning ────────────────────────────────────────────────────────────

const CSS_URL_RE = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^"')\s]+))\s*\)/dgi;
const CSS_IMPORT_RE =
  /@import\s+(?:url\(\s*(?:"([^"]+)"|'([^']+)'|([^"')\s]+))\s*\)|"([^"]+)"|'([^']+)')/dgi;
const FONT_FACE_BLOCK_RE = /@font-face\s*\{[^}]*\}/gi;

/**
 * Length-preserving blanking of CSS block comments via a linear O(n) scan
 * (CSS comments do not nest) — same shape as `maskHtmlComments`, no regex
 * backtracking on adversarial input.
 */
function stripCssComments(css: string): string {
  const chunks: string[] = [];
  let cursor = 0;
  while (true) {
    const start = css.indexOf("/*", cursor);
    if (start === -1) break;
    const end = css.indexOf("*/", start + 2);
    if (end === -1) break;
    const afterComment = end + 2;
    chunks.push(css.slice(cursor, start), " ".repeat(afterComment - start));
    cursor = afterComment;
  }
  return chunks.length === 0 ? css : chunks.join("") + css.slice(cursor);
}

function collectCssUrls(
  css: string,
  refs: ExtractedRef[],
  kind: LedgerAssetKind,
  via: LedgerAssetVia,
  at: OffsetMap,
): void {
  let match: RegExpExecArray | null;
  CSS_URL_RE.lastIndex = 0;
  while ((match = CSS_URL_RE.exec(css)) !== null) {
    pushRef(refs, kind, firstGroup(match, [1, 2, 3]), via, at);
  }
}

function collectCssRefs(
  css: string,
  refs: ExtractedRef[],
  via: LedgerAssetVia,
  at: OffsetMap,
): void {
  let source = stripCssComments(css);

  let importMatch: RegExpExecArray | null;
  CSS_IMPORT_RE.lastIndex = 0;
  while ((importMatch = CSS_IMPORT_RE.exec(source)) !== null) {
    pushRef(refs, "stylesheet", firstGroup(importMatch, [1, 2, 3, 4, 5]), "css-import", at);
  }
  // Blank @import statements so their url() doesn't double-count as an image.
  source = source.replace(CSS_IMPORT_RE, (m) => " ".repeat(m.length));

  // @font-face src urls are fonts; everything else (backgrounds, masks,
  // cursors) counts as image — the closest declared-asset category.
  let fontMatch: RegExpExecArray | null;
  FONT_FACE_BLOCK_RE.lastIndex = 0;
  while ((fontMatch = FONT_FACE_BLOCK_RE.exec(source)) !== null) {
    const blockStart = fontMatch.index;
    collectCssUrls(fontMatch[0], refs, "font", via, (index) => at(blockStart + index));
  }
  source = source.replace(FONT_FACE_BLOCK_RE, (m) => " ".repeat(m.length));

  collectCssUrls(source, refs, "image", via, at);
}

function collectStyleBlockRefs(html: string, refs: ExtractedRef[]): void {
  const styleBlockRe = /<style\b[^>]*>([\s\S]*?)<\/style\b[^>]*>/dgi;
  let match: RegExpExecArray | null;
  while ((match = styleBlockRe.exec(html)) !== null) {
    const body = firstGroup(match, [1]);
    if (body) collectCssRefs(body.value, refs, "css-url", (index) => body.start + index);
  }
}

// ── Ledger assembly ─────────────────────────────────────────────────────────

/** Every declared asset reference in one HTML document, in source order. */
export function extractAssetRefs(html: string): ExtractedRef[] {
  const refs: ExtractedRef[] = [];
  const withoutComments = maskHtmlComments(html);
  collectTagRefs(withoutComments, refs);
  collectScriptRefs(withoutComments, refs);
  collectStyleBlockRefs(withoutComments, refs);
  return refs;
}

/** Every declared reference in one project file; a `.css` file is scanned as a stylesheet. */
export function extractFileAssetRefs(file: string, text: string): ExtractedRef[] {
  if (!/\.css$/i.test(file)) return extractAssetRefs(text);
  const refs: ExtractedRef[] = [];
  collectCssRefs(text, refs, "css-url", (index) => index);
  return refs;
}

/** Classify one extracted reference into a full ledger row, or null to skip. */
function toLedgerAsset(
  file: string,
  ref: ExtractedRef,
  options: BuildLedgerOptions,
): LedgerAssetRef | null {
  const classified = classifyAssetUrl(ref.url);
  if (classified === "skip") return null;

  let status: LedgerAssetStatus = classified === "local-candidate" ? "missing" : classified;
  let localPath: string | undefined;
  if (classified === "local-candidate") {
    localPath = options.resolveLocalAsset?.(file, ref.url) ?? undefined;
    if (localPath !== undefined) status = "local";
  }
  return {
    kind: ref.kind,
    url: ref.url,
    rawUrl: ref.rawUrl,
    status,
    file,
    via: ref.via,
    ...(localPath !== undefined ? { localPath } : {}),
  };
}

/** Build a ledger from in-memory HTML sources. Pure except for the resolver. */
export function buildAssetLedger(
  inputs: LedgerFileInput[],
  options: BuildLedgerOptions = {},
): AssetLedger {
  const assets: LedgerAssetRef[] = [];
  const remoteUrls: string[] = [];
  const seenRemote = new Set<string>();
  const counts = { total: 0, remote: 0, local: 0, data: 0, missing: 0 };

  for (const input of inputs) {
    for (const ref of extractFileAssetRefs(input.file, input.html)) {
      const asset = toLedgerAsset(input.file, ref, options);
      if (!asset) continue;
      counts.total += 1;
      counts[asset.status] += 1;
      if (asset.status === "remote" && !seenRemote.has(asset.url)) {
        seenRemote.add(asset.url);
        remoteUrls.push(asset.url);
      }
      assets.push(asset);
    }
  }

  return { files: inputs.map((i) => i.file), assets, counts, remoteUrls };
}

// ── Project scanning (node-only) ────────────────────────────────────────────

const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".cache"]);

/** Recursively list project-root-relative `.html` and `.css` files, sorted for stability. */
export function collectProjectHtmlFiles(projectDir: string): string[] {
  const root = resolve(projectDir);
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          walk(join(dir, entry.name));
        }
      } else if (entry.isFile() && /\.(html|css)$/i.test(entry.name)) {
        // Posix separators keep ledger output identical across platforms.
        files.push(relative(root, join(dir, entry.name)).replace(/\\/g, "/"));
      }
    }
  };
  walk(root);
  return files.sort();
}

/**
 * Resolve one URL declared in `fromFile` (root-relative) against the project:
 * relative URLs resolve from the declaring file's directory, `/`-prefixed and
 * bare root-relative URLs from the project root (both via the shared
 * candidate logic in `@hyperframes/parsers/asset-resolution`).
 */
function resolveDeclaredLocalAsset(
  projectDir: string,
  fromFile: string,
  url: string,
): string | null {
  const fromDir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/")) : "";
  const relativeToFile = fromDir && !url.startsWith("/") ? `${fromDir}/${url}` : url;
  const hit =
    resolveExistingLocalAsset(projectDir, relativeToFile) ??
    resolveExistingLocalAsset(projectDir, url);
  return hit ? hit.rootRelativePath.replace(/\\/g, "/") : null;
}

/** Scan a project directory on disk and build its asset ledger. */
export function buildProjectAssetLedger(
  projectDir: string,
  options: { files?: string[] } = {},
): AssetLedger {
  const root = resolve(projectDir);
  const files = options.files ?? collectProjectHtmlFiles(root);
  const inputs: LedgerFileInput[] = [];
  for (const file of files) {
    let html: string;
    try {
      html = readFileSync(join(root, file), "utf-8");
    } catch {
      continue;
    }
    inputs.push({ file, html });
  }
  return buildAssetLedger(inputs, {
    resolveLocalAsset: (fromFile, url) => resolveDeclaredLocalAsset(root, fromFile, url),
  });
}
