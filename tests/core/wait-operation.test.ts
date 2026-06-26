import { describe, expect, it } from "vitest";
import { waitForOperation } from "../../src/core/wait-operation";
import { ExitCode } from "../../src/core/types";

describe("core wait operation", () => {
  it("validates --json in operation mode directly", async () => {
    const result = await waitForOperation({
      operation: "get_dubbing",
      json: "{bad",
      statusPath: "data.status",
      success: "done",
    });

    expect(result.exitCode).toBe(ExitCode.InputValidation);
    expect(result.env.ok).toBe(false);
    if (!result.env.ok) expect(result.env.error.message).toContain("--json is not valid JSON");
  });
});
