import { describe, expect, it } from "vitest";
import { parseEnvelope, recordValue, runCli } from "../helpers/cli-result";

describe("config debug env fallthrough", () => {
  it("config get honors ELV_DEBUG when --debug is not passed", async () => {
    const { stdout, code } = await runCli(["config", "get"], { ELV_DEBUG: "1" });

    expect(code).toBe(0);
    const envelope = parseEnvelope(stdout);
    expect(envelope.ok).toBe(true);
    const data = recordValue(envelope.data, "data");
    expect(data.debug).toBe(true);
  });

  it("config get reports debug false when ELV_DEBUG is unset and --debug is not passed", async () => {
    const { stdout, code } = await runCli(["config", "get"], { ELV_DEBUG: "" });

    expect(code).toBe(0);
    const envelope = parseEnvelope(stdout);
    expect(envelope.ok).toBe(true);
    const data = recordValue(envelope.data, "data");
    expect(data.debug).toBe(false);
  });
});
