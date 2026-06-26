import { describe, expect, it } from "vitest";
import { handleCall } from "../../src/commands/call";
import { ExitCode } from "../../src/core/types";

describe("call command", () => {
  it("validates malformed JSON before registry or network work", async () => {
    const result = await handleCall("text_to_speech_full", { json: "{bad" });

    expect(result.exitCode).toBe(ExitCode.InputValidation);
    expect(result.env.ok).toBe(false);
    if (!result.env.ok) expect(result.env.error.message).toContain("JSON input is not valid JSON");
  });
});
