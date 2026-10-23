/**
 * Publish a file under `src/generated` so a concurrent reader never observes it
 * half-written.
 *
 * The root build runs several package builds at once, and more than one of them
 * regenerates files here while a sibling's `tsc` is reading them. A plain
 * `writeFileSync` leaves the target truncated and then growing for the duration of
 * the write, which surfaces in whichever build read it mid-flight as
 * `TS1002: Unterminated string literal` — a failure that never reproduces locally,
 * because locally nothing is reading at that instant.
 *
 * Writing to a temp file in the same directory and renaming over the target makes
 * publication one atomic step: a reader sees either the whole previous file or the
 * whole new one, never a prefix. Same directory matters — `rename` is only atomic
 * within a filesystem.
 *
 * Byte-identical content is not republished, so a no-op rebuild leaves the mtime
 * alone and nothing downstream that keys off mtime is needlessly invalidated.
 *
 * Returns whether the target was replaced.
 *
 * Lives inside `packages/core` rather than the repo-root `scripts/` because every
 * container image that builds a package copies `packages/…` wholesale but
 * cherry-picks root scripts one file at a time. A helper the core build imports
 * has to travel with the package, or the image build fails on a missing module.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function writeGeneratedFile(outPath: string, contents: string): boolean {
  if (existsSync(outPath) && readFileSync(outPath, "utf8") === contents) return false;

  mkdirSync(dirname(outPath), { recursive: true });
  // Not a `.ts` suffix: the temp file sits inside the package's `src` glob, and a
  // concurrent `tsc` would otherwise try to compile it.
  const tempPath = `${outPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tempPath, contents, "utf8");
    renameSync(tempPath, outPath);
  } finally {
    rmSync(tempPath, { force: true });
  }
  return true;
}

/**
 * What the codegen needs from oxfmt's `format()`: the formatted code, plus any
 * parse/format errors. Declared structurally rather than imported so the fallback
 * path does not depend on oxfmt's types being installed, and so a test double can
 * stand in for the real formatter.
 */
export interface GeneratedFormatResult {
  code: string;
  errors: Array<{ message: string }>;
}

export type GeneratedSourceFormatter = (
  fileName: string,
  sourceText: string,
  options?: Record<string, unknown>,
) => Promise<GeneratedFormatResult>;

/**
 * The repo's .oxfmtrc.json, so the published artifact matches what the lefthook
 * pre-commit hook (`oxfmt {staged_files}`) would commit. Best effort: a container
 * that builds this package without the repo root beside it gets oxfmt's defaults,
 * which today equal the repo's settings.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadOxfmtConfig(): Record<string, unknown> | undefined {
  try {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const parsed: unknown = JSON.parse(readFileSync(join(repoRoot, ".oxfmtrc.json"), "utf8"));
    if (!isRecord(parsed)) return undefined;
    delete parsed.$schema;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Formats through oxfmt's JS API; imported lazily so the fallback can report a missing install. */
async function oxfmtFormatter(
  fileName: string,
  sourceText: string,
  options?: Record<string, unknown>,
): Promise<GeneratedFormatResult> {
  const { format } = await import("oxfmt");
  return format(fileName, sourceText, options);
}

/**
 * Runs the generated source through oxfmt so it is published already formatted.
 * Formatting the file after publishing it would rewrite it in place and reopen
 * the very window the atomic rename closes.
 *
 * Uses oxfmt's JS API rather than spawning `bun x oxfmt`: these scripts run
 * under tsx/node, and on Windows a Node process cannot spawn `bun` when PATH
 * only carries the extensionless shim — the spawn fails with ENOENT and the
 * silently unformatted artifact then blocks `git pull` (issue #5856). The API
 * runs in-process, so formatting no longer depends on a spawnable bun.
 *
 * Still best effort: an environment without oxfmt gets a valid, unformatted
 * artifact AND a warning, so the fallback is never invisible.
 */
export async function formatGeneratedSource(
  source: string,
  outPath: string,
  formatter: GeneratedSourceFormatter = oxfmtFormatter,
): Promise<string> {
  try {
    const result = await formatter(outPath, source, loadOxfmtConfig());
    if (result.errors.length > 0) {
      throw new Error(result.errors.map((error) => error.message).join("; "));
    }
    return result.code;
  } catch (err) {
    console.warn(
      `[codegen] oxfmt could not format ${outPath} (${err instanceof Error ? err.message : String(err)}); publishing the unformatted source. The file is still valid, but re-run the build with oxfmt available or the working tree will show formatting-only drift.`,
    );
    return source;
  }
}
