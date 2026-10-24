import { readdirSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { blobPath } from "./blobStore.js";
import { isHistoryId } from "./historyId.js";
import { readLog } from "./historyLog.js";
import { HistoryBusyError, takeHistoryOwnership } from "./ownerLock.js";
import { uncopiedOnlyHashes } from "./uncopied.js";

export interface ReclaimedHistory {
  id: string;
  bytes: number;
}

async function sizeOfBlob(blobs: string, hash: string): Promise<number> {
  return (await stat(blobPath(blobs, hash)).catch(() => null))?.size ?? 0;
}

/** Drops the media copies older versions left in every history no running process holds; the same rule as on open. */
export async function reclaimUncopiedBlobs(
  historyRoot: string,
  { dryRun = false, onError }: { dryRun?: boolean; onError?: (error: unknown) => void } = {},
): Promise<ReclaimedHistory[]> {
  const reclaimed: ReclaimedHistory[] = [];
  const ids = (() => {
    try {
      return readdirSync(historyRoot).filter(isHistoryId);
    } catch {
      return [];
    }
  })();
  for (const id of ids) {
    const home = join(historyRoot, id);
    let release: (() => void) | undefined;
    try {
      release = await takeHistoryOwnership(home, 0);
      const log = readLog(join(home, "log.jsonl"), () => {});
      if (!log) continue;
      const blobs = join(home, "blobs");
      const sizes = new Map<string, number>();
      for (const entry of log.entries)
        for (const file of entry.files)
          for (const hash of [file.before, file.after])
            if (hash && !sizes.has(hash)) sizes.set(hash, await sizeOfBlob(blobs, hash));
      for (const hash of log.baseline.values())
        if (!sizes.has(hash)) sizes.set(hash, await sizeOfBlob(blobs, hash));
      let bytes = 0;
      for (const hash of uncopiedOnlyHashes(log, (known) => sizes.get(known) ?? 0)) {
        const size = sizes.get(hash) ?? 0;
        if (size === 0) continue;
        bytes += size;
        if (!dryRun) await rm(blobPath(blobs, hash), { force: true });
      }
      if (bytes > 0) reclaimed.push({ id, bytes });
    } catch (error) {
      if (!(error instanceof HistoryBusyError)) onError?.(error);
    } finally {
      release?.();
    }
  }
  return reclaimed;
}
