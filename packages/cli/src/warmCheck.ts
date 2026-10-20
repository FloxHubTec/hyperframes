import { unlinkSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { prelaunchBrowserForCheck } from "./commands/check.js";
import "./utils/checkBrowser.js";
import { registerRootExitRequester } from "./utils/commandResult.js";
import {
  Frame,
  encodeFrame,
  frameForwarder,
  frameReader,
  sameEnv,
  type WarmRequest,
} from "./warmCheckProtocol.js";

const [address = "", idleMs = "0", ...checkArgs] = process.argv.slice(2);
const startEnv = { ...process.env };
const exit = process.exit.bind(process);
const idle = setTimeout(() => exit(0), Number(idleMs));
registerRootExitRequester(exit);
let listening = false;

process.on("exit", () => {
  if (listening && process.platform !== "win32") {
    try {
      unlinkSync(address);
    } catch {}
  }
});

async function serve(socket: Socket, request: WarmRequest): Promise<void> {
  if (!sameEnv(request.env, startEnv)) {
    socket.end(encodeFrame(Frame.Declined, "environment"), () => exit(0));
    return;
  }
  let finished = false;
  const finish = (code: number) => {
    if (finished) return;
    finished = true;
    socket.end(encodeFrame(Frame.Exit, String(code)), () => exit(code));
  };
  socket.on("close", () => {
    if (!finished) process.kill(process.pid, "SIGKILL");
  });
  process.stdout.write = frameForwarder(socket, Frame.Stdout);
  process.stderr.write = frameForwarder(socket, Frame.Stderr);
  process.exit = ((code?: number | string | null) =>
    finish(Number(code ?? process.exitCode ?? 0))) as typeof process.exit;
  process.chdir(request.cwd);
  process.argv = [process.execPath, request.script, ...request.argv];
  await import(new URL("./cli.js", import.meta.url).href);
  setImmediate(() => finish(Number(process.exitCode ?? 0)));
}

const server = createServer((socket) => {
  server.close();
  listening = false;
  clearTimeout(idle);
  let requested = false;
  socket.on("error", () => {});
  socket.on("close", () => {
    if (!requested) exit(0);
  });
  socket.on(
    "data",
    frameReader((type, body) => {
      if (type === Frame.Request && !requested) {
        requested = true;
        void serve(socket, JSON.parse(body.toString()) as WarmRequest);
      }
      if (type === Frame.Signal) process.kill(process.pid, body.toString() as NodeJS.Signals);
    }),
  );
});

function listen(): void {
  server.listen(address, () => {
    listening = true;
  });
}

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EADDRINUSE" || process.platform === "win32") exit(0);
  const probe = connect(address, () => exit(0));
  probe.on("error", () => {
    try {
      unlinkSync(address);
    } catch {}
    listen();
  });
});

listen();
void prelaunchBrowserForCheck(checkArgs).catch(() => undefined);
