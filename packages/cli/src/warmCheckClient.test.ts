import { describe, expect, it } from "vitest";
import { runWarmCheck, warmCheckEligible, warmCheckOutcome } from "./warmCheckClient.js";

describe("warmCheckEligible", () => {
  const argv = ["node", "hyperframes", "check", "."];

  it("hands an agent's check to a warm process", () => {
    expect(warmCheckEligible(argv, {}, false, false)).toBe(true);
  });

  it("keeps terminals, CI, help and other commands cold", () => {
    expect(warmCheckEligible(argv, {}, true, false)).toBe(false);
    expect(warmCheckEligible(argv, {}, false, true)).toBe(false);
    expect(warmCheckEligible(argv, { CI: "true" }, false, false)).toBe(false);
    expect(warmCheckEligible([...argv, "--help"], {}, false, false)).toBe(false);
    expect(warmCheckEligible(["node", "hyperframes", "lint", "."], {}, false, false)).toBe(false);
  });
});

describe("warmCheckOutcome", () => {
  it("takes the warm process's exit code", () => {
    expect(warmCheckOutcome(3, true, undefined)).toEqual({ served: true, exitCode: 3 });
  });

  it("lets the check run cold when the warm process declined before any output", () => {
    expect(warmCheckOutcome(undefined, false, undefined)).toEqual({ served: false });
  });

  it("reports a warm process that stopped mid-output instead of running the check twice", () => {
    expect(warmCheckOutcome(undefined, true, undefined)).toEqual({
      served: true,
      exitCode: 1,
      message: "The warm check process stopped before finishing.\n",
    });
  });

  it("exits like a signalled process when the user interrupted the check", () => {
    expect(warmCheckOutcome(undefined, false, "SIGINT")).toEqual({ served: true, exitCode: 130 });
  });
});

describe("runWarmCheck", () => {
  it("runs cold without connecting anywhere when there is no private endpoint", async () => {
    await expect(runWarmCheck(undefined)).resolves.toBe(false);
  });
});
