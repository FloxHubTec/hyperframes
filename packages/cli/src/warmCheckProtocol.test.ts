import { describe, expect, it } from "vitest";
import { Frame, encodeFrame, frameForwarder, frameReader, sameEnv } from "./warmCheckProtocol.js";

describe("sameEnv", () => {
  it("ignores the shell's per-command variables and unset values", () => {
    expect(
      sameEnv({ A: "1", _: "/x", PWD: "/a", B: undefined }, { A: "1", _: "/y", OLDPWD: "/b" }),
    ).toBe(true);
  });

  it("tells apart any added, removed or changed variable", () => {
    expect(sameEnv({ A: "1" }, { A: "2" })).toBe(false);
    expect(sameEnv({ A: "1" }, { A: "1", B: "1" })).toBe(false);
    expect(sameEnv({ A: "1", B: "1" }, { A: "1" })).toBe(false);
  });
});

describe("frames", () => {
  it("decodes frames however the bytes are split", () => {
    const bytes = Buffer.concat([
      encodeFrame(Frame.Stdout, "héllo"),
      encodeFrame(Frame.Exit, "0"),
      encodeFrame(Frame.Stderr, Buffer.alloc(0)),
    ]);
    const seen: [number, string][] = [];
    const read = frameReader((type, body) => seen.push([type, body.toString()]));
    for (const byte of bytes) read(Buffer.from([byte]));
    expect(seen).toEqual([
      [Frame.Stdout, "héllo"],
      [Frame.Exit, "0"],
      [Frame.Stderr, ""],
    ]);
  });
});

describe("frameForwarder", () => {
  it("hands every write to the socket before returning, so ending the socket loses none", () => {
    const sent: Buffer[] = [];
    const write = frameForwarder({ write: (chunk: Buffer) => sent.push(chunk) > 0 }, Frame.Stdout);
    write("one ");
    write(Buffer.from("two "));
    write("thrée", "utf8");
    const seen: string[] = [];
    frameReader((_type, body) => seen.push(body.toString()))(Buffer.concat(sent));
    expect(seen).toEqual(["one ", "two ", "thrée"]);
  });
});
