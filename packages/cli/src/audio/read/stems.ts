import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { findFfBinary } from "@hyperframes/parsers/ff-binaries";
import { HyperframesCloudClient } from "../../cloud/_gen/client.js";
import { uploadAssetViaDirectUpload } from "../../cloud/upload.js";
import { runFile, serviceConfig, serviceFailure } from "../analysis/providers/shared.js";

/**
 * The stem separation service contract.
 *
 * Request: `POST <HYPERFRAMES_AUDIO_STEMS_URL>` with `x-api-key: <HYPERFRAMES_AUDIO_API_KEY>`, a new
 * `Idempotency-Key`, and `{ version: 1, audio: { type: "asset_id", asset_id } }`. The recording is uploaded
 * first as 192 kb/s stereo MP3 through the same origin's asset direct-upload routes.
 *
 * Response: `{ data: StemsJob }`, or a bare `StemsJob`. While `status` is `pending` or `processing`,
 * `GET <HYPERFRAMES_AUDIO_STEMS_URL>/<id>` returns the job again. A `completed` job lists one URL per stem;
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

export const VOICE_STEM = "vocals";
export const DRUM_STEM = "drums";

const config = () =>
  serviceConfig({ url: URL_ENV, key: KEY_ENV, timeout: TIMEOUT_ENV }, DEFAULT_TIMEOUT_MS);

/** Why stems cannot be fetched here, or null when they can. */
export function stemsUnavailable(): string | null {
  const { url, key } = config();
  if (!url) return `${URL_ENV} is not set`;
  if (!key) return `${KEY_ENV} is not set`;
  return null;
}

/** Stems already fetched into `dir`, by name; null when there are none yet. */
export function cachedStems(dir: string): Record<string, string> | null {
  const done = join(dir, DONE);
  if (!existsSync(done)) return null;
  const names = JSON.parse(readFileSync(done, "utf8")) as Record<string, string>;
  const paths = Object.fromEntries(Object.entries(names).map(([n, f]) => [n, join(dir, f)]));
  return Object.values(paths).every((p) => existsSync(p)) ? paths : null;
}

async function job(response: Response): Promise<StemsJob> {
  if (!response.ok) throw await serviceFailure(response, "the stems service");
  const body = (await response.json()) as { data?: StemsJob } | StemsJob | null;
  const value = (body && "data" in body ? body.data : body) as StemsJob | undefined;
  if (!value?.id || !value.status) throw new Error("the stems service answered without a job");
  return value;
}

async function encoded(path: string, dir: string): Promise<string> {
  const ffmpeg = findFfBinary("ffmpeg", { configuredMustExist: true });
  if (!ffmpeg) throw new Error("ffmpeg is required to separate stems; run: npx hyperframes doctor");
  const out = join(dir, "upload.mp3");
  await runFile(
    ffmpeg,
    ["-v", "error", "-y", "-i", path, "-vn", "-ac", "2", "-ar", "44100", "-b:a", "192k", out],
    { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
  );
  return out;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Separate the recording through the configured service and save each stem into `dir`. */
export async function fetchStems(path: string, dir: string): Promise<Record<string, string>> {
  const { url, key, timeoutMs } = config();
  if (!url || !key) throw new Error(stemsUnavailable()!);
  const deadline = Date.now() + timeoutMs;
  const headers = { "x-api-key": key };
  const scratch = await mkdtemp(join(tmpdir(), "hf-stems-"));
  try {
    const mp3 = await encoded(path, scratch);
    const client = new HyperframesCloudClient({
      baseUrl: new URL(url).origin,
      getAuthHeaders: () => headers,
      fetchImpl: (input, init) => fetch(input, { ...init, redirect: "error" }),
    });
    const asset = await uploadAssetViaDirectUpload({
      client,
      path: mp3,
      size: statSync(mp3).size,
      filename: "audio.mp3",
      contentType: "audio/mpeg",
      idempotencyKey: randomUUID(),
    });
    let current = await job(
      await fetch(url, {
        method: "POST",
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
      if (Date.now() > deadline)
        throw new Error(`stem separation did not finish within ${Math.round(timeoutMs / 1000)} s`);
      await sleep(POLL_MS);
      current = await job(
        await fetch(`${url.replace(/\/$/, "")}/${encodeURIComponent(current.id)}`, {
          redirect: "error",
          headers,
        }),
      );
    }
    if (current.status !== "completed")
      throw new Error(
        `stem separation failed${current.error?.message ? `: ${current.error.message}` : ""}`,
      );
    const stems = current.stems ?? [];
    if (!stems.some((s) => s.name === VOICE_STEM))
      throw new Error("the stems service returned no vocals stem");
    mkdirSync(dir, { recursive: true });
    const names: Record<string, string> = {};
    for (const stem of stems) {
      const response = await fetch(stem.url);
      if (!response.ok)
        throw new Error(`could not download the ${stem.name} stem: ${response.status}`);
      const file = `${stem.name.replace(/[^\w-]/g, "_")}${extname(new URL(stem.url).pathname) || ".mp3"}`;
      writeFileSync(join(dir, file), Buffer.from(await response.arrayBuffer()));
      names[stem.name] = file;
    }
    writeFileSync(join(dir, DONE), JSON.stringify(names));
    return cachedStems(dir)!;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
