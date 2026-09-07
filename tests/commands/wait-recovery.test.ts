import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { runOperation } from "../../src/core/client";
import { success } from "../../src/core/envelope";
import type { CommandResult } from "../../src/core/types";
import { waitAfterCreate } from "../../src/commands/aliases/shared";

const signals = vi.hoisted(() => {
  const handlers = new Map<string, () => void>();
  return {
    handlers,
    on: (name: string, handler: () => void) => {
      handlers.set(name, handler);
    },
    off: (name: string) => {
      handlers.delete(name);
    },
  };
});
vi.mock("../../src/core/client", () => ({ runOperation: vi.fn() }));
vi.mock("../../src/core/errors", async (original) => ({
  ...(await original<typeof import("../../src/core/errors")>()),
  emitAndExit: (env: CommandResult["env"], exitCode: number) => {
    throw { env, exitCode };
  },
}));
vi.mock("../../src/core/wait-operation", async (original) => {
  const actual = await original<typeof import("../../src/core/wait-operation")>();
  return {
    ...actual,
    waitForOperation: (
      options: Parameters<typeof actual.waitForOperation>[0],
      deps: Parameters<typeof actual.waitForOperation>[1],
    ) => actual.waitForOperation(options, { ...deps, signals }),
  };
});
afterEach(() => {
  vi.clearAllMocks();
  signals.handlers.clear();
});

async function interruptedCreate(id: string) {
  let cancelled = false;
  vi.mocked(runOperation).mockImplementation(
    (_operation, _input, opts) =>
      new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener(
          "abort",
          () => {
            cancelled = true;
            reject(opts.signal?.reason);
          },
          { once: true },
        );
        queueMicrotask(() => signals.handlers.get("SIGINT")?.());
      }),
  );
  const created = success({
    cmd: "elv fixture create",
    operation_id: "create_fixture",
    data: { id },
  });
  let result: CommandResult;
  try {
    await waitAfterCreate(
      created,
      {},
      {
        commandName: "elv fixture create",
        idKeys: ["id"],
        missingIdMessage: "missing id",
        operation: "get_fixture",
        pathKey: "job_id",
        statusPath: "data.status",
        success: "done",
        failure: "failed",
        timing: { timeoutMs: 1000 },
      },
    );
    throw new Error("expected emission");
  } catch (error) {
    result = error as CommandResult;
  }
  expect(cancelled).toBe(true);
  expect(runOperation).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({
    exitCode: 7,
    env: {
      ok: false,
      error: { code: "wait_interrupted", raw: { envelope: null } },
      retry: { recommended: false },
    },
  });
  return result.env;
}

it("keeps the created job and re-poll command when the first alias poll is interrupted", async () => {
  const env = await interruptedCreate("job_123");
  expect(env.hints?.[0]?.cmd).toBe('elv call get_fixture --json \'{"path":{"job_id":"job_123"}}\'');
  expect(env.hints?.[0]?.why).toContain("instead of resubmitting");
  expect(env.hints?.[0]?.why).not.toContain("still running");
  expect(env.ok ? "" : env.error.message).not.toContain("child");
});

it("shell-quotes arbitrary created job IDs in the fallback recovery command", async () => {
  const id = "job'with spaces";
  const env = await interruptedCreate(id);
  const hint = env.hints?.[0]?.cmd;
  expect(hint).toBeDefined();
  // Execute only a shell function that prints argv; no elv binary/provider runs.
  const stdout = execFileSync("sh", ["-c", `elv() { printf '%s' "$4"; }; ${hint}`], {
    encoding: "utf8",
    timeout: 1000,
  });
  expect(JSON.parse(stdout)).toEqual({ path: { job_id: id } });
});
