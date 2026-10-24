import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream, renameSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { atomicTempPath } from "@hyperframes/core/atomic-file";

/** File contents stored once by sha256, text and binary alike. */
export interface BlobStore {
  /** Copies the file in (a clone where the file system can) and returns the copy's hash. */
  put(absPath: string): Promise<string>;
  reference(absPath: string): Promise<string>;
  has(hash: string): boolean;
  read(hash: string): Promise<Buffer>;
  /** Writes the blob's bytes to `absPath` by clone-or-copy and rename, so a reader never sees half a file. */
  writeTo(hash: string, absPath: string, beforeReplace?: () => void): Promise<void>;
  bytes(): number;
  size(hash: string): number;
  keep(absPath: string, remove: boolean): Promise<void>;
  prune(keep: ReadonlySet<string>): Promise<void>;
  drop(hashes: Iterable<string>): Promise<void>;
}

const BLOB_HASH = /^[0-9a-f]{64}$/;

export function blobPath(dir: string, hash: string): string {
  // Checked where the path is joined, so no caller can read or write outside the store.
  if (!BLOB_HASH.test(hash)) throw new Error("That is not a history blob.");
  return join(dir, hash.slice(0, 2), hash);
}

export const readBlob = (dir: string, hash: string) => readFile(blobPath(dir, hash));

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function cloneOrStream(from: string, to: string): Promise<void> {
  try {
    await copyFile(from, to, constants.COPYFILE_FICLONE_FORCE);
  } catch {
    const { mode } = await stat(from);
    await pipeline(createReadStream(from), createWriteStream(to, { mode }));
  }
}

async function cloneOrCopy(from: string, to: string, beforeReplace?: () => void): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  const temp = atomicTempPath(to);
  try {
    await copyFile(from, temp, constants.COPYFILE_FICLONE);
    beforeReplace?.();
    renameSync(temp, to);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export async function openBlobStore(dir: string): Promise<BlobStore> {
  const sizes = new Map<string, number>();
  // Bytes history moved out of the project live apart from the blobs, so reclaiming old media copies never takes them.
  const asideDir = join(dirname(dir), "aside");
  const aside = new Set<string>();
  await mkdir(dir, { recursive: true });
  for (const [root, isAside] of [
    [dir, false],
    [asideDir, true],
  ] as const)
    for (const shard of await readdir(root).catch(() => []))
      for (const hash of await readdir(join(root, shard)).catch(() => [])) {
        if (sizes.has(hash)) continue;
        sizes.set(hash, (await stat(join(root, shard, hash))).size);
        if (isAside) aside.add(hash);
      }
  const pathOf = (hash: string) => blobPath(aside.has(hash) ? asideDir : dir, hash);
  const forget = async (hash: string) => {
    await rm(pathOf(hash), { force: true });
    total -= sizes.get(hash) ?? 0;
    sizes.delete(hash);
    aside.delete(hash);
  };
  let total = [...sizes.values()].reduce((sum, size) => sum + size, 0);

  return {
    async put(absPath) {
      // Hash the copy, not the source, so a write racing the copy can never file bytes under the wrong hash.
      const temp = join(dir, `incoming-${randomUUID()}`);
      // Recreated if removed while open, so a missing folder is never mistaken for a deleted project file.
      await mkdir(dir, { recursive: true });
      await cloneOrStream(absPath, temp).catch(async (error) => {
        await rm(temp, { force: true });
        throw error;
      });
      const hash = await hashFile(temp);
      if (sizes.has(hash)) {
        await rm(temp, { force: true });
        return hash;
      }
      await mkdir(dirname(pathOf(hash)), { recursive: true });
      const size = (await stat(temp)).size;
      await rename(temp, pathOf(hash));
      sizes.set(hash, size);
      total += size;
      return hash;
    },
    reference: (absPath) => hashFile(absPath),
    has: (hash) => sizes.has(hash),
    read: (hash) => readFile(pathOf(hash)),
    async writeTo(hash, absPath, beforeReplace) {
      await cloneOrCopy(pathOf(hash), absPath, beforeReplace);
      if (aside.has(hash)) await forget(hash);
    },
    async keep(absPath, remove) {
      const hash = await hashFile(absPath);
      if (sizes.has(hash)) return;
      const to = blobPath(asideDir, hash);
      await mkdir(dirname(to), { recursive: true });
      const moved =
        remove &&
        (await rename(absPath, to).then(
          () => true,
          () => false,
        ));
      if (!moved) await cloneOrStream(absPath, to);
      sizes.set(hash, (await stat(to)).size);
      aside.add(hash);
      total += sizes.get(hash)!;
    },
    bytes: () => total,
    size: (hash) => sizes.get(hash) ?? 0,
    async drop(hashes) {
      for (const hash of hashes) if (sizes.has(hash) && !aside.has(hash)) await forget(hash);
    },
    async prune(keep) {
      for (const hash of [...sizes.keys()]) if (!keep.has(hash)) await forget(hash);
    },
  };
}
