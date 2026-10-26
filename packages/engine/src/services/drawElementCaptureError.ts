/** A drawElement page cannot supply trusted pixels; retry on a fresh screenshot page. */
export class DrawElementCaptureError extends Error {
  readonly frameIndex: number;

  constructor(frameIndex: number, reason: string, cause?: unknown) {
    super(
      `drawElement capture failed at frame ${frameIndex}: ${reason}; fresh screenshot capture required`,
      { cause },
    );
    this.name = "DrawElementCaptureError";
    // Consumed structurally across package/worker error boundaries.
    Object.defineProperty(this, "deCaptureFailure", { value: true, enumerable: true });
    this.frameIndex = frameIndex;
  }
}

/**
 * A frame whose worker encode fails after it was produced (timeout, worker error, empty frame) is the same
 * untrusted-page failure as a failed produce, so it takes the same fresh-session recovery.
 */
export function asDrawElementCaptureFailure(
  frameIndex: number,
  encodeResult: Promise<Buffer>,
): Promise<Buffer> {
  const wrapped = encodeResult.catch((cause: unknown) => {
    if (isDrawElementCaptureError(cause)) throw cause;
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new DrawElementCaptureError(frameIndex, reason, cause);
  });
  // The pipeline can orphan a produced frame when an earlier one fails; its rejection is then expected.
  void wrapped.catch(() => {});
  return wrapped;
}

/** Structural matching survives engine/producer copies and worker error wrappers. */
export function isDrawElementCaptureError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    if ("deCaptureFailure" in current && current.deCaptureFailure === true) return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}
