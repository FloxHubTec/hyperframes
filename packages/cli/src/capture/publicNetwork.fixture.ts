import { promises as dns } from "node:dns";
import { createRequire, syncBuiltinESMExports } from "node:module";

const server = process.env.HF_TEST_DNS ?? "";
if (!server) throw new Error("Missing DNS server");
const Resolver = dns.Resolver;
dns.Resolver = class extends Resolver {
  constructor(options?: ConstructorParameters<typeof Resolver>[0]) {
    super(options);
    this.setServers([server]);
  }
};
// HF_TEST_SYSTEM: "stall" for a system lookup that never returns, or the address it answers.
const system = process.env.HF_TEST_SYSTEM ?? "stall";
const childProcess = createRequire(import.meta.url)("node:child_process");
const execFile = childProcess.execFile;
childProcess.execFile = (file: string, _args: string[], ...rest: unknown[]) =>
  execFile(
    file,
    [
      "-e",
      system === "stall" ? "setInterval(() => {}, 1000)" : `process.stdout.write('["${system}"]')`,
    ],
    ...rest,
  );
syncBuiltinESMExports();
const { resolvePublicAddress } = await import("./publicNetwork.js");
const outcome = await resolvePublicAddress("assets.capture-fixture.com").catch(
  (error: Error) => error.message,
);
process.stdout.write(`${outcome}\n`);
