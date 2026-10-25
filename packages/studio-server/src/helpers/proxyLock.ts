import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const POLL_MS = 500;
const UNREADABLE_LOCK_MS = 10_000;

function lockPathFor(cachePath: string): string {
  return join(dirname(cachePath), `.lock-${basename(cachePath)}`);
}

function ownerIsAlive(lockPath: string): boolean {
  try {
    const pid = Number(readFileSync(lockPath, "utf8"));
    if (!Number.isInteger(pid) || pid <= 0) {
      return Date.now() - statSync(lockPath).mtimeMs < UNREADABLE_LOCK_MS;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  } catch {
    return false;
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The right to make the copy at `cachePath`, so two processes sharing a cache never make it at once. Waits
 * while another process holds it and returns null when that process finished the copy; takes over from an
 * owner that died, so its finished pieces are reused. Call the returned function when done.
 */
export async function acquireCopyLock(
  cachePath: string,
  signal: AbortSignal,
): Promise<(() => void) | null> {
  const lockPath = lockPathFor(cachePath);
  for (;;) {
    signal.throwIfAborted();
    if (existsSync(cachePath)) return null;
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      if (!existsSync(cachePath)) return () => rmSync(lockPath, { force: true });
      rmSync(lockPath, { force: true });
      return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    if (ownerIsAlive(lockPath)) await pause(POLL_MS, signal);
    else rmSync(lockPath, { force: true });
  }
}
