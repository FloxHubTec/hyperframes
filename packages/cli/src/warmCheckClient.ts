import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { connect, type Socket } from "node:net";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";
import {
  Frame,
  WARM_IDLE_MS,
  encodeFrame,
  frameReader,
  warmCheckAddress,
} from "./warmCheckProtocol.js";

const distDir = dirname(fileURLToPath(import.meta.url));
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const launchEnv = { ...process.env };

export function warmCheckEligible(
  argv = process.argv,
  env = process.env,
  stdoutTTY = process.stdout.isTTY,
  stderrTTY = process.stderr.isTTY,
): boolean {
  return argv[2] === "check" && !stdoutTTY && !stderrTTY && !env.CI && !argv.includes("--help");
}

export function warmCheckOutcome(
  exitCode: number | undefined,
  wrote: boolean,
  signalled: NodeJS.Signals | undefined,
): { served: boolean; exitCode?: number; message?: string } {
  if (exitCode !== undefined) return { served: true, exitCode };
  if (signalled) return { served: true, exitCode: 128 + (constants.signals[signalled] ?? 0) };
  if (!wrote) return { served: false };
  return {
    served: true,
    exitCode: 1,
    message: "The warm check process stopped before finishing.\n",
  };
}

function connected(address: string): Promise<Socket | undefined> {
  return new Promise((resolveSocket) => {
    const socket = connect(address);
    socket.once("connect", () => resolveSocket(socket));
    socket.once("error", () => resolveSocket(undefined));
  });
}

export async function runWarmCheck(address = warmCheckAddress(distDir)): Promise<boolean> {
  const socket = await connected(address);
  if (!socket) return false;
  let wrote = false;
  let signalled: (typeof FORWARDED_SIGNALS)[number] | undefined;
  const relay = (signal: (typeof FORWARDED_SIGNALS)[number]) => {
    signalled = signal;
    socket.write(encodeFrame(Frame.Signal, signal));
  };
  for (const signal of FORWARDED_SIGNALS) process.on(signal, relay);
  try {
    return await new Promise<boolean>((resolveRun) => {
      let exitCode: number | undefined;
      const sinks = new Map<Frame, NodeJS.WritableStream>([
        [Frame.Stdout, process.stdout],
        [Frame.Stderr as Frame, process.stderr],
      ]);
      socket.on(
        "data",
        frameReader((type, body) => {
          if (type === Frame.Exit) exitCode = Number(body.toString());
          wrote ||= sinks.get(type)?.write(body) !== undefined;
        }),
      );
      socket.on("error", () => {});
      socket.on("close", () => {
        const outcome = warmCheckOutcome(exitCode, wrote, signalled);
        if (outcome.message) process.stderr.write(outcome.message);
        if (outcome.served) process.exitCode = outcome.exitCode;
        resolveRun(outcome.served);
      });
      socket.write(
        encodeFrame(
          Frame.Request,
          JSON.stringify({
            argv: process.argv.slice(2),
            script: process.argv[1],
            cwd: process.cwd(),
            env: launchEnv,
          }),
        ),
      );
    });
  } finally {
    for (const signal of FORWARDED_SIGNALS) process.off(signal, relay);
  }
}

export function startNextWarmCheck(address = warmCheckAddress(distDir)): void {
  const args = [address, String(WARM_IDLE_MS), ...process.argv.slice(3)];
  spawn(process.execPath, [join(distDir, "warmCheck.js"), ...args], {
    cwd: process.cwd(),
    env: launchEnv,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
}
