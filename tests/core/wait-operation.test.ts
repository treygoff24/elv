import { describe, expect, it } from "vitest";
import { waitForOperation } from "../../src/core/wait-operation";
import { success } from "../../src/core/envelope";
import { ExitCode } from "../../src/core/types";
import type { Envelope } from "../../src/core/types";

function env(status: string): Envelope {
  return success({ cmd: "elv call get_dubbing", operation_id: "get_dubbing", data: { status } });
}

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

  it("caps sleep to the remaining timeout and does not poll after the deadline", async () => {
    let now = 0;
    let polls = 0;
    const sleeps: number[] = [];

    const result = await waitForOperation(
      {
        operation: "get_dubbing",
        json: "{}",
        statusPath: "data.status",
        success: "done",
        intervalMs: 1_000,
        timeoutMs: 100,
      },
      {
        now: () => now,
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
        runOperation: async () => {
          polls += 1;
          return env("queued");
        },
      },
    );

    expect(result.exitCode).toBe(ExitCode.TransientExhausted);
    expect(result.env.ok).toBe(false);
    if (!result.env.ok) expect(result.env.error.code).toBe("wait_timeout");
    expect(polls).toBe(1);
    expect(sleeps).toEqual([100]);
  });
});
