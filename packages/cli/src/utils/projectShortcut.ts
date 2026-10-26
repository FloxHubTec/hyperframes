import { statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Where the root command word sits in argv, or -1. The root has no value-taking options: Citty
 * skips flags up to the first positional and stops subcommand selection at the -- separator.
 */
export function commandWordIndex(argv: readonly string[]): number {
  const end = argv.indexOf("--");
  const index = argv.findIndex((arg) => !arg.startsWith("-"));
  return end >= 0 && index >= end ? -1 : index;
}

/**
 * `hyperframes <dir>` is `hyperframes open <dir>`. A known command always wins, even over a
 * folder with its name; any other command word must be an existing directory to count as a project.
 */
export function openShortcutArgv(
  argv: readonly string[],
  commands: ReadonlySet<string>,
  cwd: string = process.cwd(),
): readonly string[] {
  const at = commandWordIndex(argv);
  if (at < 0 || commands.has(argv[at]!)) return argv;
  try {
    if (!statSync(resolve(cwd, argv[at]!)).isDirectory()) return argv;
  } catch {
    return argv;
  }
  return [...argv.slice(0, at), "open", ...argv.slice(at)];
}
