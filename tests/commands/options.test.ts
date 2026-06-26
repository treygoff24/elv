import { Command } from "commander";
import { describe, expect, it } from "vitest";
import {
  collect,
  mergedOptions,
  numberValue,
  OptionValueError,
  runOptsFromOptions,
} from "../../src/commands/options";

describe("command option helpers", () => {
  it("normalizes common run options", () => {
    expect(
      runOptsFromOptions({
        dryRun: true,
        yes: true,
        maxCredits: "12",
        out: "out",
        retryPost: true,
      }),
    ).toMatchObject({ dryRun: true, yes: true, maxCredits: 12, out: "out", retryPost: true });
  });

  it("merges parent command options before child options", () => {
    const parent = new Command().option("--profile <name>");
    parent.opts().profile = "p1";
    const child = parent.command("child").option("--out <path>");
    child.opts().out = "out";

    expect(mergedOptions(child)).toMatchObject({ profile: "p1", out: "out" });
  });

  it("collects repeatable values and rejects non-numeric numbers", () => {
    expect(collect("b", ["a"])).toEqual(["a", "b"]);
    expect(() => numberValue("NaN-ish")).toThrow(OptionValueError);
  });
});
