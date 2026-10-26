import { statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * `hyperframes <dir>` is `hyperframes open <dir>`. A known command always wins, even over a
 * folder with its name; any other first word must be an existing directory to count as a project.
 */
export function openShortcutArgv(
  argv: readonly string[],
  commands: ReadonlySet<string>,
  cwd: string = process.cwd(),
): readonly string[] {
  const first = argv[0];
  if (!first || first.startsWith("-") || commands.has(first)) return argv;
  try {
    if (!statSync(resolve(cwd, first)).isDirectory()) return argv;
  } catch {
    return argv;
  }
  return ["open", ...argv];
}
