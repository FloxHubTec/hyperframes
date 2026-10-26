// Exact rational, so NTSC rates reach FFmpeg as `30000/1001` with no decimal round trip.
export interface Fps {
  num: number;
  den: number;
}

export type FpsInput = number | Fps;

export function toFps(input: FpsInput): Fps {
  if (typeof input === "number") {
    return { num: input, den: 1 };
  }
  return input;
}

export function fpsToNumber(fps: Fps): number {
  return fps.num / fps.den;
}

export function fpsToFfmpegArg(fps: Fps): string {
  return fps.den === 1 ? String(fps.num) : `${fps.num}/${fps.den}`;
}

export type FpsParseResult =
  | { ok: true; value: Fps }
  | {
      ok: false;
      reason:
        | "empty"
        | "not-a-number"
        | "non-positive"
        | "out-of-range"
        | "invalid-fraction"
        | "ambiguous-decimal";
    };

// Decimals like "29.97" are rejected: FFmpeg reads them as a different rate than 30000/1001.
export function parseFps(input: string | number): FpsParseResult {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return { ok: false, reason: "not-a-number" };
    if (!Number.isInteger(input)) return { ok: false, reason: "ambiguous-decimal" };
    if (input <= 0) return { ok: false, reason: "non-positive" };
    if (input > 240) return { ok: false, reason: "out-of-range" };
    return { ok: true, value: { num: input, den: 1 } };
  }
  const raw = input.trim();
  if (raw === "") return { ok: false, reason: "empty" };

  if (raw.includes("/")) {
    const parts = raw.split("/");
    if (parts.length !== 2) return { ok: false, reason: "invalid-fraction" };
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    if (!Number.isFinite(num) || !Number.isFinite(den)) {
      return { ok: false, reason: "not-a-number" };
    }
    if (!Number.isInteger(num) || !Number.isInteger(den)) {
      return { ok: false, reason: "invalid-fraction" };
    }
    if (den <= 0) return { ok: false, reason: "invalid-fraction" };
    if (num <= 0) return { ok: false, reason: "non-positive" };
    const decimal = num / den;
    if (decimal < 1 || decimal > 240) return { ok: false, reason: "out-of-range" };
    return { ok: true, value: { num, den } };
  }

  if (!/^-?\d+$/.test(raw)) {
    if (/^-?\d*\.\d+$/.test(raw)) return { ok: false, reason: "ambiguous-decimal" };
    return { ok: false, reason: "not-a-number" };
  }
  const n = Number(raw);
  if (n <= 0) return { ok: false, reason: "non-positive" };
  if (n > 240) return { ok: false, reason: "out-of-range" };
  return { ok: true, value: { num: n, den: 1 } };
}

export function parseFpsWithDefault(input: string | number | undefined): FpsParseResult {
  if (input === undefined || input === "") return { ok: true, value: { num: 30, den: 1 } };
  return parseFps(input);
}
