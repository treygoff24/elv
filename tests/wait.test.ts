import { describe, expect, it } from "vitest";
import { waitForOperation } from "../src/commands/wait";
import { success } from "../src/core/envelope";
import { ExitCode } from "../src/core/types";
import type { Envelope } from "../src/core/types";

function env(status: string): Envelope {
  return success({ cmd: "elv call get_dubbing", operation_id: "get_dubbing", data: { status } });
}

describe("wait command", () => {
  it("polls runOperation in-process until success", async () => {
    const seen: unknown[] = [];
    const result = await waitForOperation(
      {
        operation: "get_dubbing",
        json: '{"path":{"dubbing_id":"dub_1"}}',
        statusPath: "$.data.status",
        success: "done,completed",
        failure: "failed,error",
        intervalMs: 1,
        timeoutMs: 100,
      },
      {
        sleep: async () => undefined,
        now: (() => {
          let t = 0;
          return () => (t += 1);
        })(),
        runOperation: async (_operation, input) => {
          seen.push(input);
          return seen.length === 1 ? env("queued") : env("done");
        },
      },
    );

    expect(result.exitCode).toBe(ExitCode.Success);
    expect(result.env.ok).toBe(true);
    expect(seen).toEqual([{ path: { dubbing_id: "dub_1" } }, { path: { dubbing_id: "dub_1" } }]);
  });

  it("returns nonzero on failure status and timeout", async () => {
    const failed = await waitForOperation(
      { operation: "op", json: "{}", statusPath: "data.status", success: "done", failure: "failed", intervalMs: 1, timeoutMs: 10 },
      { sleep: async () => undefined, now: () => 1, runOperation: async () => env("failed") },
    );
    expect(failed.exitCode).not.toBe(ExitCode.Success);
    expect(failed.env.ok).toBe(false);

    let t = 0;
    const timedOut = await waitForOperation(
      { operation: "op", json: "{}", statusPath: "data.status", success: "done", failure: "failed", intervalMs: 1, timeoutMs: 2 },
      { sleep: async () => undefined, now: () => (t += 2), runOperation: async () => env("queued") },
    );
    expect(timedOut.exitCode).not.toBe(ExitCode.Success);
    expect(timedOut.env.ok).toBe(false);
    if (!timedOut.env.ok) expect(timedOut.env.error.code).toBe("wait_timeout");
  });

  it("rejects wildcard status paths", async () => {
    const result = await waitForOperation(
      { operation: "op", json: "{}", statusPath: "data.items[*].status", success: "done", failure: "failed" },
      { sleep: async () => undefined, now: () => 0, runOperation: async () => env("done") },
    );
    expect(result.exitCode).toBe(ExitCode.InputValidation);
    expect(result.env.ok).toBe(false);
  });
});
