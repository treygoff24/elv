import { describe, expect, it } from "vitest";
import { waitForOperation } from "../../src/commands/wait";
import { success } from "../../src/core/envelope";
import { ExitCode } from "../../src/core/types";
import type { Envelope } from "../../src/core/types";

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
      {
        operation: "op",
        json: "{}",
        statusPath: "data.status",
        success: "done",
        failure: "failed",
        intervalMs: 1,
        timeoutMs: 10,
      },
      { sleep: async () => undefined, now: () => 1, runOperation: async () => env("failed") },
    );
    expect(failed.exitCode).not.toBe(ExitCode.Success);
    expect(failed.env.ok).toBe(false);

    let t = 0;
    const timedOut = await waitForOperation(
      {
        operation: "op",
        json: "{}",
        statusPath: "data.status",
        success: "done",
        failure: "failed",
        intervalMs: 1,
        timeoutMs: 2,
      },
      {
        sleep: async () => undefined,
        now: () => (t += 2),
        runOperation: async () => env("queued"),
      },
    );
    expect(timedOut.exitCode).not.toBe(ExitCode.Success);
    expect(timedOut.env.ok).toBe(false);
    if (!timedOut.env.ok) expect(timedOut.env.error.code).toBe("wait_timeout");
  });

  it("rejects wildcard status paths", async () => {
    const result = await waitForOperation(
      {
        operation: "op",
        json: "{}",
        statusPath: "data.items[*].status",
        success: "done",
        failure: "failed",
      },
      { sleep: async () => undefined, now: () => 0, runOperation: async () => env("done") },
    );
    expect(result.exitCode).toBe(ExitCode.InputValidation);
    expect(result.env.ok).toBe(false);
  });

  it("rejects mixed command and operation modes", async () => {
    const result = await waitForOperation({
      cmd: '["elv","config","get"]',
      operation: "op",
      json: "{}",
      statusPath: "data.status",
      success: "done",
    });

    expect(result.exitCode).toBe(ExitCode.InputValidation);
    expect(result.env.ok).toBe(false);
    if (!result.env.ok) expect(result.env.error.message).toContain("--cmd cannot be combined");
  });

  it("returns validation envelopes for invalid timing options", async () => {
    const result = await waitForOperation({
      operation: "op",
      json: "{}",
      statusPath: "data.status",
      success: "done",
      intervalMs: "0",
    });

    expect(result.exitCode).toBe(ExitCode.InputValidation);
    expect(result.env.ok).toBe(false);
    if (!result.env.ok) expect(result.env.error.message).toContain("--interval-ms");
  });

  it("reports invalid child command output with context", async () => {
    const result = await waitForOperation({
      cmd: JSON.stringify([
        process.execPath,
        "-e",
        "process.stdout.write('not-json'); process.stderr.write('bad stderr'); process.exit(7)",
      ]),
      statusPath: "data.status",
      success: "done",
      intervalMs: 1,
      timeoutMs: 1,
    });

    expect(result.exitCode).toBe(ExitCode.ProviderError);
    expect(result.env.ok).toBe(false);
    if (!result.env.ok) {
      expect(result.env.error.code).toBe("command_output_invalid");
      expect(result.env.error.raw).toMatchObject({ exit_code: 7, stdout: "not-json" });
    }
  });

  it("polls without --failure until success or timeout", async () => {
    const succeeded = await waitForOperation(
      {
        operation: "op",
        json: "{}",
        statusPath: "data.status",
        success: "done",
        intervalMs: 1,
        timeoutMs: 100,
      },
      { sleep: async () => undefined, now: () => 1, runOperation: async () => env("done") },
    );
    expect(succeeded.exitCode).toBe(ExitCode.Success);
    expect(succeeded.env.ok).toBe(true);

    let t = 0;
    const timedOut = await waitForOperation(
      {
        operation: "op",
        json: "{}",
        statusPath: "data.status",
        success: "done",
        intervalMs: 1,
        timeoutMs: 2,
      },
      {
        sleep: async () => undefined,
        now: () => (t += 2),
        runOperation: async () => env("queued"),
      },
    );
    expect(timedOut.exitCode).not.toBe(ExitCode.Success);
    expect(timedOut.env.ok).toBe(false);
    if (!timedOut.env.ok) expect(timedOut.env.error.code).toBe("wait_timeout");
  });
});
