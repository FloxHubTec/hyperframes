import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findFfBinary } from "@hyperframes/parsers/ff-binaries";
import { setTimeout as sleep } from "node:timers/promises";
import { downloadToFile } from "../../cloud/download.js";
import { HyperframesCloudClient } from "../../cloud/_gen/client.js";
import { uploadAssetViaDirectUpload } from "../../cloud/upload.js";
import {
  runFile,
  serviceAccess,
  serviceFailure,
  type ServiceAccess,
} from "../analysis/providers/shared.js";

/**
 * The stem separation service contract.
 *
 * Request: `POST /v3/audio/stems` on the HeyGen API with the CLI's HeyGen credential, or `POST
 * <HYPERFRAMES_AUDIO_STEMS_URL>` with `x-api-key: <HYPERFRAMES_AUDIO_API_KEY>`; a new `Idempotency-Key`, and
 * `{ version: 1, audio: { type: "asset_id", asset_id } }`. The recording is uploaded
 * first as 192 kb/s stereo MP3 through the same origin's asset direct-upload routes.
 *
 * Response: `{ data: StemsJob }`, or a bare `StemsJob`. While `status` is `pending` or `processing`,
 * `GET <that url>/<id>` returns the job again. A `completed` job lists one URL per stem;
 * the names are vocals, drums, bass, guitar, piano and other.
 */
interface StemsJob {
  id: string;
  status: "pending" | "processing" | "completed" | "failed";
  stems?: { name: string; url: string }[];
  error?: { message?: string };
}

const URL_ENV = "HYPERFRAMES_AUDIO_STEMS_URL";
const KEY_ENV = "HYPERFRAMES_AUDIO_API_KEY";
const TIMEOUT_ENV = "HYPERFRAMES_AUDIO_STEMS_TIMEOUT_MS";
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const POLL_MS = 5000;
const DONE = "stems.json";
const STEM_NAMES = ["vocals", "drums", "bass", "guitar", "piano", "other"] as const;

export const VOICE_STEM = "vocals";
export const DRUM_STEM = "drums";

/** How to reach the stems service, or why it cannot be reached. */
export const stemsAccess = () =>
  serviceAccess(
    { url: URL_ENV, key: KEY_ENV, timeout: TIMEOUT_ENV },
    "/v3/audio/stems",
    DEFAULT_TIMEOUT_MS,
  );

/** Stems already fetched into `dir`, by name; null when there are none yet. */
export function cachedStems(dir: string): Record<string, string> | null {
  const done = join(dir, DONE);
  if (!existsSync(done)) return null;
  const names = JSON.parse(readFileSync(done, "utf8")) as Record<string, string>;
  if (!STEM_NAMES.every((name) => typeof names[name] === "string")) return null;
  const paths = Object.fromEntries(STEM_NAMES.map((name) => [name, join(dir, names[name]!)]));
  return Object.values(paths).every((p) => existsSync(p)) ? paths : null;
}

async function job(response: Response): Promise<StemsJob> {
  if (!response.ok) throw await serviceFailure(response, "the stems service");
  const body = (await response.json()) as { data?: StemsJob } | StemsJob | null;
  const value = (body && "data" in body ? body.data : body) as StemsJob | undefined;
  if (!value?.id || !value.status) throw new Error("the stems service answered without a job");
  return value;
}

async function encoded(path: string, dir: string, signal: AbortSignal): Promise<string> {
  const ffmpeg = findFfBinary("ffmpeg", { configuredMustExist: true });
  if (!ffmpeg) throw new Error("ffmpeg is required to separate stems; run: npx hyperframes doctor");
  const out = join(dir, "upload.mp3");
  await runFile(
    ffmpeg,
    ["-v", "error", "-y", "-i", path, "-vn", "-ac", "2", "-ar", "44100", "-b:a", "192k", out],
    { windowsHide: true, maxBuffer: 8 * 1024 * 1024, signal },
  );
  return out;
}

/** Separate the recording through the configured service and save each stem into `dir`. */
export async function fetchStems(
  path: string,
  dir: string,
  { url, headers, timeoutMs }: ServiceAccess,
): Promise<Record<string, string>> {
  const signal = AbortSignal.timeout(timeoutMs);
  const scratch = await mkdtemp(join(tmpdir(), "hf-stems-"));
  try {
    const mp3 = await encoded(path, scratch, signal);
    const client = new HyperframesCloudClient({
      baseUrl: new URL(url).origin,
      getAuthHeaders: () => headers,
      fetchImpl: (input, init) => fetch(input, { ...init, redirect: "error", signal }),
    });
    const asset = await uploadAssetViaDirectUpload({
      client,
      path: mp3,
      size: statSync(mp3).size,
      filename: "audio.mp3",
      contentType: "audio/mpeg",
      idempotencyKey: randomUUID(),
      signal,
    });
    let current = await job(
      await fetch(url, {
        method: "POST",
        signal,
        redirect: "error",
        headers: {
          ...headers,
          "idempotency-key": randomUUID(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ version: 1, audio: { type: "asset_id", asset_id: asset.asset_id } }),
      }),
    );
    while (current.status === "pending" || current.status === "processing") {
      await sleep(POLL_MS, undefined, { signal });
      current = await job(
        await fetch(`${url.replace(/\/$/, "")}/${encodeURIComponent(current.id)}`, {
          redirect: "error",
          headers,
          signal,
        }),
      );
    }
    if (current.status !== "completed")
      throw new Error(
        `stem separation failed${current.error?.message ? `: ${current.error.message}` : ""}`,
      );
    const stems = current.stems ?? [];
    const missing = STEM_NAMES.filter((name) => !stems.some((stem) => stem.name === name));
    if (missing.length)
      throw new Error(
        `the stems service returned an incomplete separation: missing ${missing.join(", ")}`,
      );
    mkdirSync(dir, { recursive: true });
    const names: Record<string, string> = {};
    for (const name of STEM_NAMES) {
      const stem = stems.find((candidate) => candidate.name === name);
      if (!stem) continue;
      const file = `${name}.audio`;
      await downloadToFile(stem.url, join(dir, file), { signal });
      names[name] = file;
    }
    writeFileSync(join(dir, DONE), JSON.stringify(names));
    return cachedStems(dir)!;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
