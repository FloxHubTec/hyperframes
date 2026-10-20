import { promises as dns } from "node:dns";

const server = process.env.HF_TEST_DNS ?? "";
if (!server) throw new Error("Missing DNS server");
const Resolver = dns.Resolver;
dns.Resolver = class extends Resolver {
  constructor(options?: ConstructorParameters<typeof Resolver>[0]) {
    super(options);
    this.setServers([server]);
  }
};
const { resolvePublicAddress } = await import("./publicNetwork.js");
const outcome = await resolvePublicAddress("assets.capture-fixture.com").catch(
  (error: Error) => error.message,
);
process.stdout.write(`${outcome}\n`);
