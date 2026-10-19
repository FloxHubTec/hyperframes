import { release } from "node:os";

/** Chrome 151 dropped macOS 12 and older (Darwin < 22); 150 is the last major that launches there. */
const MACOS_12_LAST_CHROME_MAJOR = 150;

/** Newest Chrome major this host can run, or undefined when it has no ceiling. */
export function chromeMajorCeiling(
  hostPlatform: string = process.platform,
  hostRelease: string = release(),
): number | undefined {
  if (hostPlatform !== "darwin") return undefined;
  return Number.parseInt(hostRelease, 10) < 22 ? MACOS_12_LAST_CHROME_MAJOR : undefined;
}

/** True when a cache dir name (`mac-152.0.1.2`) or build id (`152.0.1.2`) is newer than the ceiling. */
export function exceedsChromeCeiling(versionName: string, ceiling: number | undefined): boolean {
  if (ceiling === undefined) return false;
  const major = Number.parseInt(versionName.slice(versionName.indexOf("-") + 1), 10);
  return major > ceiling;
}

// Deliberately Beta, not Canary: 153.0.8000.0 measured identical to this build on every probe. macOS 12 gets 150,
// the last headless shell that launches there; it exposes canvas.drawElementImage under CanvasDrawElement.
const CHROME_VERSION = "152.0.7977.30";
const MACOS_12_CHROME_VERSION = "150.0.7871.124";

/** The one place that decides which chrome-headless-shell build HyperFrames installs, matches and launches. */
export function managedChromeVersion(
  hostPlatform: string = process.platform,
  hostRelease: string = release(),
): string {
  return chromeMajorCeiling(hostPlatform, hostRelease) === undefined
    ? CHROME_VERSION
    : MACOS_12_CHROME_VERSION;
}

/** True when a cache dir name (`mac_arm-152.0.7977.30`) is the managed build. */
export const isManagedChromeDir = (versionName: string): boolean =>
  versionName.slice(versionName.indexOf("-") + 1) === managedChromeVersion();
