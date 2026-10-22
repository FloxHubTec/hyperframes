import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { findFfBinary } from "@hyperframes/parsers/ff-binaries";
import { readAudio } from "./read.js";

const RATE = 22_050;
const dir = mkdtempSync(join(tmpdir(), "hf-audio-read-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function wav(name: string, seconds: number, fill: (t: number) => number): string {
  const frames = Math.round(seconds * RATE);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++)
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, fill(i / RATE))) * 32767), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  const path = join(dir, name);
  writeFileSync(path, Buffer.concat([header, data]));
  return path;
}

const voiced = (t: number) =>
  (t >= 0.5 && t < 2) || (t >= 3 && t < 4.5) ? 0.3 * Math.sin(2 * Math.PI * 180 * t) : 0;
const boom = (t: number) =>
  t < 2.4 ? 0 : 0.7 * Math.exp(-(t - 2.4) / 0.3) * Math.sin(2 * Math.PI * 55 * (t - 2.4));
const bed = (t: number) =>
  t > 5 && t < 6
    ? 0
    : 0.08 * Math.sin(2 * Math.PI * 261.63 * t) + 0.08 * Math.sin(2 * Math.PI * 392 * t);

let server: Server;
let polls = 0;
let stemCalls = 0;
let stemRequest: unknown = null;
const stemFiles: Record<string, string> = {};

async function body(req: IncomingMessage) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const origin = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

type Reply = (status: number, value: unknown) => void;

const routes: Record<string, (reply: Reply, req: IncomingMessage, bytes: Buffer) => void> = {
  "POST /v3/assets/direct-uploads": (reply) =>
    reply(200, {
      data: { asset_id: "episode", upload_url: `${origin()}/put`, upload_headers: {} },
    }),
  "PUT /put": (reply) => reply(200, {}),
  "POST /v3/assets/episode/complete": (reply) => reply(200, { data: { asset_id: "episode" } }),
  "POST /v3/audio/stems": (reply, req, bytes) => {
    expect(req.headers["x-api-key"]).toBe("test-key");
    stemCalls++;
    stemRequest = JSON.parse(bytes.toString());
    reply(202, { data: { id: "job-1", status: "processing" } });
  },
  "GET /v3/audio/stems/job-1": (reply) => {
    polls++;
    reply(200, {
      data: {
        id: "job-1",
        status: "completed",
        stems: Object.keys(stemFiles).map((name) => ({
          name,
          url: `${origin()}/stem/${name}.wav`,
        })),
      },
    });
  },
};

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const bytes = await body(req);
    const reply: Reply = (status, value) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    const route = routes[`${req.method} ${req.url}`];
    if (route) return route(reply, req, bytes);
    const stem = req.url?.match(/^\/stem\/(\w+)\.wav$/)?.[1];
    if (stem && stemFiles[stem]) return res.writeHead(200).end(readFileSync(stemFiles[stem]));
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
});

afterAll(() => new Promise<void>((done) => server.close(() => done())));

afterEach(() => {
  delete process.env.HYPERFRAMES_AUDIO_STEMS_URL;
  delete process.env.HYPERFRAMES_AUDIO_API_KEY;
});

const ffmpeg = findFfBinary("ffmpeg") && findFfBinary("ffprobe");

describe.skipIf(!ffmpeg)("readAudio", () => {
  it("reads the mix with its sidecar transcript when there are no stems, and reuses the cache", async () => {
    const path = wav("talk.wav", 6, (t) => voiced(t));
    writeFileSync(
      `${path}.transcript.json`,
      JSON.stringify({
        audio: "talk.wav",
        words: [
          { text: "一口气", start: 0.5, end: 1.4 },
          { text: "了解。", start: 1.4, end: 2 },
          { text: "伊朗", start: 3, end: 4.5 },
        ],
      }),
    );
    const cacheDir = join(dir, "cache-mix");
    const first = await readAudio(path, "talk.wav", { cacheDir });
    expect(first.cached).toBe(false);
    expect(first.analysis).toMatchObject({ separation: "mix", stems: [], music: null });
    expect(first.analysis.voice!.sentences.map((s) => s.text)).toEqual(["一口气了解。", "伊朗"]);
    expect(first.analysis.voice!.medianPitchHz).toBeGreaterThan(170);
    expect(first.analysis.warnings.join("\n")).toContain("HYPERFRAMES_AUDIO_STEMS_URL is not set");
    const text = readFileSync(first.textPath, "utf8");
    expect(text).toContain('voice   "一口气了解。"');
    expect(text).toContain("pause   1.0 s");
    const again = await readAudio(path, "talk.wav", { cacheDir });
    expect(again.cached).toBe(true);
    writeFileSync(
      `${path}.transcript.json`,
      JSON.stringify({ words: [{ text: "换了", start: 0.5, end: 2 }] }),
    );
    const edited = await readAudio(path, "talk.wav", { cacheDir });
    expect(edited.cached).toBe(false);
    expect(edited.analysis.voice!.sentences[0]!.text).toBe("换了");
  });

  it("separates through the stems service, then reads effects from the drums and the bed from the rest", async () => {
    stemFiles.vocals = wav("vocals.wav", 8, voiced);
    stemFiles.drums = wav("drums.wav", 8, boom);
    stemFiles.piano = wav("piano.wav", 8, bed);
    stemFiles.bass = wav("bass.wav", 8, () => 0);
    const path = wav("episode.wav", 8, (t) => voiced(t) + boom(t) + bed(t));
    process.env.HYPERFRAMES_AUDIO_STEMS_URL = `${origin()}/v3/audio/stems`;
    process.env.HYPERFRAMES_AUDIO_API_KEY = "test-key";
    const cacheDir = join(dir, "cache-stems");
    const { analysis, textPath } = await readAudio(path, "episode.wav", { cacheDir });
    expect(stemRequest).toEqual({ version: 1, audio: { type: "asset_id", asset_id: "episode" } });
    expect(polls).toBe(1);
    expect(analysis).toMatchObject({
      separation: "stems",
      stems: ["bass", "drums", "piano", "vocals"],
      warnings: [expect.stringContaining("no transcript")],
    });
    expect(analysis.voice!.source).toBe("activity");
    expect(analysis.effects!.events.map((e) => [Math.round(e.t * 10) / 10, e.kind])).toEqual([
      [2.4, "boom"],
    ]);
    expect(analysis.effects!.events[0]!.overMusicDb).toBeGreaterThan(5);
    expect(analysis.music!.breaks.map((b) => Math.round(b.start))).toEqual([5]);
    expect(analysis.music!.segments.map((s) => s.entry)).toEqual(["start", "resumes"]);
    expect(readFileSync(textPath, "utf8")).toContain("effect  boom (S1): low");
    expect(existsSync(join(cacheDir, "stems"))).toBe(true);
    await readAudio(path, "episode.wav", { cacheDir });
    expect(stemCalls).toBe(1);
  });

  it("keeps audio on the machine at quality local, and reads neither voice nor effects from a bare mix", async () => {
    process.env.HYPERFRAMES_AUDIO_STEMS_URL = `${origin()}/v3/audio/stems`;
    process.env.HYPERFRAMES_AUDIO_API_KEY = "test-key";
    const path = wav("local.wav", 3, voiced);
    const { analysis } = await readAudio(path, "local.wav", {
      cacheDir: join(dir, "cache-local"),
      quality: "local",
    });
    expect(analysis).toMatchObject({ separation: "mix", voice: null, effects: null });
    expect(analysis.warnings[0]).toContain("quality local keeps audio on this machine");
    expect(analysis.warnings[1]).toContain("no transcript and no stems");
  });
});
