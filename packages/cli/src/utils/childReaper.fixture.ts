// fallow-ignore-file unused-file
import { writeFileSync } from "node:fs";
import { runCancellableProcess } from "./cancellableProcess.js";

const [readyPath] = process.argv.slice(2);
if (!readyPath) throw new Error("Missing fixture arguments");

// Like a synchronous lint with the setup worker's signal handlers: its event loop never turns again, so SIGTERM is
// queued for a handler that never runs, and nothing inside it can notice the parent go.
const childSource = [
  'import { spawn } from "node:child_process";',
  'import { writeFileSync } from "node:fs";',
  'process.on("SIGTERM", () => {});',
  'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
  "writeFileSync(process.argv[1], JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));",
  "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);",
].join("\n");

void runCancellableProcess(
  process.execPath,
  ["--input-type=module", "--eval", childSource, `${readyPath}.child`],
  {
    onSpawn: () => writeFileSync(readyPath, String(process.pid)),
  },
).catch(() => undefined);
setInterval(() => undefined, 1000);
