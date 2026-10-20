import { Semaphore } from "./semaphore.js";

const MEDIA_PROBE_CONCURRENCY = 4;
const ADVISORY_MEDIA_PROBE_CONCURRENCY = 2;

/**
 * Process-wide because compiler advisories can outlive compileForRender and
 * overlap the later media-type preflight. A per-phase limiter would still let
 * those independently scheduled probe pools multiply subprocess load.
 */
export const sharedMediaProbeSemaphore = new Semaphore(MEDIA_PROBE_CONCURRENCY);
const advisoryMediaProbeSemaphore = new Semaphore(ADVISORY_MEDIA_PROBE_CONCURRENCY);

export async function withMediaProbeSlot<T>(operation: () => Promise<T>): Promise<T> {
  const release = await sharedMediaProbeSemaphore.acquire();
  try {
    return await operation();
  } finally {
    release();
  }
}

/**
 * For probes nothing awaits. A full-file keyframe scan can hold its slot for
 * the whole ffprobe deadline, so advisories never take every shared slot.
 */
export async function withAdvisoryMediaProbeSlot<T>(operation: () => Promise<T>): Promise<T> {
  const releaseAdvisory = await advisoryMediaProbeSemaphore.acquire();
  try {
    return await withMediaProbeSlot(operation);
  } finally {
    releaseAdvisory();
  }
}
