import { runCancellableProcess } from "../utils/cancellableProcess.js";

/**
 * Unzip with its input closed. On a write error (a full disk) unzip asks "Continue? (y/n)" and waits on its input,
 * which `@puppeteer/browsers` leaves open, so its own unzip hangs forever. False when there is no unzip binary.
 */
export async function unzipArchive(archivePath: string, folderPath: string): Promise<boolean> {
  try {
    await runCancellableProcess("unzip", ["-q", "-o", archivePath, "-d", folderPath]);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    const said = (err as { stderr?: string }).stderr?.trim();
    throw new Error(`Extraction failed: ${said || (err as Error).message}`, { cause: err });
  }
}
