import { createHash } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { Writable } from "node:stream";
import { join } from "node:path";

export const WARM_IDLE_MS = 5 * 60_000;

export const Frame = { Stdout: 1, Stderr: 2, Exit: 3, Declined: 4, Signal: 5, Request: 6 } as const;
export type Frame = (typeof Frame)[keyof typeof Frame];

export interface WarmRequest {
  argv: string[];
  script: string;
  cwd: string;
  env: Record<string, string | undefined>;
}

const VOLATILE_ENV = new Set(["_", "PWD", "OLDPWD"]);

export function sameEnv(
  a: Record<string, string | undefined>,
  b: Record<string, string | undefined>,
): boolean {
  const keys = (env: Record<string, string | undefined>) =>
    Object.keys(env)
      .filter((key) => !VOLATILE_ENV.has(key) && env[key] !== undefined)
      .sort();
  const left = keys(a);
  const right = keys(b);
  return (
    left.length === right.length && left.every((key, i) => key === right[i] && a[key] === b[key])
  );
}

export function warmCheckAddress(distDir: string, platform = process.platform): string {
  const cli = statSync(join(distDir, "cli.js"));
  const build = createHash("sha256")
    .update([distDir, cli.size, cli.mtimeMs, process.execPath, process.version].join("\0"))
    .digest("hex")
    .slice(0, 16);
  const user = String(userInfo().uid >= 0 ? userInfo().uid : userInfo().username);
  if (platform === "win32") return `\\\\.\\pipe\\hyperframes-warm-check-${user}-${build}`;
  const dir = join(tmpdir(), `hyperframes-warm-${user}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, `${build}.sock`);
}

export function encodeFrame(type: Frame, data: string | Uint8Array): Buffer {
  const body = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
  const head = Buffer.alloc(5);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

export function frameReader(onFrame: (type: Frame, body: Buffer) => void): (chunk: Buffer) => void {
  let pending = Buffer.alloc(0);
  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 5) {
      const length = pending.readUInt32BE(1);
      if (pending.length < 5 + length) return;
      onFrame(pending.readUInt8(0) as Frame, pending.subarray(5, 5 + length));
      pending = pending.subarray(5 + length);
    }
  };
}

export function frameForwarder(
  socket: { write(frame: Buffer): unknown },
  type: Frame,
): typeof process.stdout.write {
  const sink = new Writable({
    write(chunk: Buffer, _encoding, next) {
      socket.write(encodeFrame(type, chunk));
      next();
    },
  });
  return sink.write.bind(sink) as typeof process.stdout.write;
}
