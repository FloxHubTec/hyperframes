/** The per-user local data folder on Windows (always writable by the user); undefined elsewhere or when unset. */
export function windowsLocalAppData(): string | undefined {
  return process.platform === "win32"
    ? process.env["LOCALAPPDATA"]?.trim() || undefined
    : undefined;
}
