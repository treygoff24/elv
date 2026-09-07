import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { success } from "../../src/core/envelope";
import { ExitCode } from "../../src/core/types";
import { waitForOperation } from "../../src/core/wait-operation";
import type { Envelope } from "../../src/core/types";
import type { JsonObject } from "../../src/util/json";

/**
 * Child-lifecycle contract for `elv wait`: --timeout-ms bounds each child run, not
 * just the gap between polls. Every fixture here is finite (self-exits well inside
 * the vitest timeout) and every pid this suite signals is a pid it recorded itself.
 */

const FIXTURE_SELF_EXIT_MS = 20_000;
const STALL_FIXTURE = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const pidsFile = process.argv[2];
// stdio inherit: the grandchild holds the stdout pipe open, so the parent's
// "close" never fires while it lives. Same process group as this child.
const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, ${FIXTURE_SELF_EXIT_MS})"], {
  stdio: "inherit",
});
writeFileSync(pidsFile, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
setTimeout(() => process.exit(0), ${FIXTURE_SELF_EXIT_MS});
`;

interface FixturePids {
  child: number;
  grandchild: number;
}

let dir: string;
let stallPath: string;
const recorded = new Set<number>();

function env(status: string): Envelope {
  return success({ cmd: "elv call get_dubbing", operation_id: "get_dubbing", data: { status } });
}

function errorRaw(envelope: Envelope): JsonObject {
  expect(envelope.ok).toBe(false);
  if (envelope.ok) throw new Error("expected an error envelope");
  return (envelope.error.raw ?? {}) as JsonObject;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until<T>(probe: () => T | undefined, budgetMs = 5_000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("condition not reached within budget");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function readPids(pidsFile: string): FixturePids | undefined {
  if (!existsSync(pidsFile)) return undefined;
  const raw = readFileSync(pidsFile, "utf8");
  if (!raw.trim()) return undefined;
  const parsed = JSON.parse(raw) as FixturePids;
  recorded.add(parsed.child);
  recorded.add(parsed.grandchild);
  return parsed;
}

/** Guards against a vacuous reap assertion: the fixtures must be alive first. */
function expectRunning(pids: FixturePids): void {
  expect(pids.child).toBeGreaterThan(0);
  expect(pids.grandchild).toBeGreaterThan(0);
  expect(pids.grandchild).not.toBe(pids.child);
  expect(alive(pids.child)).toBe(true);
  expect(alive(pids.grandchild)).toBe(true);
}

function stallCmd(pidsFile: string): string {
  return JSON.stringify([process.execPath, stallPath, pidsFile]);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "elv-wait-child-"));
  stallPath = join(dir, "stall-with-grandchild.mjs");
  writeFileSync(stallPath, STALL_FIXTURE);
});

afterEach(async () => {
  // Only pids this suite recorded from its own fixtures are ever signalled.
  for (const pid of recorded) {
    if (alive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
  recorded.clear();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("wait child deadline", () => {
  it("rejects a child success that lands after the deadline", async () => {
    const started = Date.now();
    const result = await waitForOperation({
      cmd: JSON.stringify([
        process.execPath,
        "-e",
        `setTimeout(() => console.log(JSON.stringify({ v: 1, ok: true, data: { status: "done" } })), 400)`,
      ]),
      statusPath: "data.status",
      success: "done",
      timeoutMs: 50,
    });

    expect(result.exitCode).toBe(ExitCode.TransientExhausted);
    expect(result.env.ok).toBe(false);
    if (!result.env.ok) expect(result.env.error.code).toBe("wait_timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("terminates a stalled child and its grandchild at the deadline", async () => {
    const pidsFile = join(dir, "stalled.json");
    const result = await waitForOperation({
      cmd: stallCmd(pidsFile),
      statusPath: "data.status",
      success: "done",
      timeoutMs: 400,
    });

    expect(result.exitCode).toBe(ExitCode.TransientExhausted);
    expect(result.env.ok).toBe(false);
    if (!result.env.ok) expect(result.env.error.code).toBe("wait_timeout");

    const pids = await until(() => readPids(pidsFile));
    expect(pids.child).toBeGreaterThan(0);
    expect(pids.grandchild).toBeGreaterThan(0);
    expect(pids.grandchild).not.toBe(pids.child);
    await until(() => (alive(pids.child) ? undefined : true));
    await until(() => (alive(pids.grandchild) ? undefined : true));
  });

  it.each(["SIGINT", "SIGTERM"])(
    "terminates the owned child on %s and returns one interrupt envelope",
    async (fired) => {
      const pidsFile = join(dir, `interrupted-${fired}.json`);
      const handlers = new Map<string, Set<() => void>>();
      const signals = {
        on(signal: string, handler: () => void): void {
          const set = handlers.get(signal) ?? new Set<() => void>();
          set.add(handler);
          handlers.set(signal, set);
        },
        off(signal: string, handler: () => void): void {
          handlers.get(signal)?.delete(handler);
        },
      };

      const pending = waitForOperation(
        {
          cmd: stallCmd(pidsFile),
          statusPath: "data.status",
          success: "done",
          timeoutMs: 15_000,
        },
        { signals },
      );

      const pids = await until(() => readPids(pidsFile));
      expectRunning(pids);
      for (const handler of handlers.get(fired) ?? []) handler();

      const result = await pending;
      expect(result.exitCode).toBe(ExitCode.TransientExhausted);
      expect(result.env.ok).toBe(false);
      if (!result.env.ok) {
        expect(result.env.error.code).toBe("wait_interrupted");
        expect(result.env.error.raw).toMatchObject({ signal: fired });
      }
      await until(() => (alive(pids.child) ? undefined : true));
      await until(() => (alive(pids.grandchild) ? undefined : true));
      // Both listeners are released, so a second signal terminates by default.
      expect(handlers.get("SIGINT")?.size ?? 0).toBe(0);
      expect(handlers.get("SIGTERM")?.size ?? 0).toBe(0);
    },
  );

  it("caps child output instead of buffering it without bound", async () => {
    const result = await waitForOperation({
      cmd: JSON.stringify([
        process.execPath,
        "-e",
        `process.stdout.write("x".repeat(3 * 1024 * 1024)); process.stderr.write("e".repeat(512 * 1024));`,
      ]),
      statusPath: "data.status",
      success: "done",
      timeoutMs: 10_000,
    });

    expect(result.env.ok).toBe(false);
    if (!result.env.ok) expect(result.env.error.code).toBe("command_output_invalid");
    const raw = errorRaw(result.env);
    expect(raw.stdout_truncated).toBe(true);
    expect(raw.stderr_truncated).toBe(true);
    expect(String(raw.stdout).length).toBeLessThan(1_000);
    expect(String(raw.stderr).length).toBeLessThan(1_000);
  });

  it("emits a single interrupt envelope and exit 7 from the real CLI on SIGINT", async () => {
    const pidsFile = join(dir, "cli-interrupted.json");
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "wait",
        "--cmd",
        stallCmd(pidsFile),
        "--status-path",
        "data.status",
        "--success",
        "done",
        "--timeout-ms",
        "15000",
      ],
      { env: process.env },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const pids = await until(() => readPids(pidsFile), 15_000);
    expectRunning(pids);
    child.kill("SIGINT");

    const code = await new Promise<number | null>((resolve) => {
      child.on("close", (value: number | null) => resolve(value));
    });

    expect(code).toBe(ExitCode.TransientExhausted);
    const lines = stdout.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const envelope = JSON.parse(lines[0] as string) as JsonObject & { error?: JsonObject };
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe("wait_interrupted");
    expect(stderr).toBe("");
    await until(() => (alive(pids.grandchild) ? undefined : true));
  });

  it("abandons a later operation poll that outlives the deadline", async () => {
    const started = Date.now();
    let polls = 0;
    const result = await waitForOperation(
      {
        operation: "get_dubbing",
        json: "{}",
        statusPath: "data.status",
        success: "done",
        intervalMs: 1,
        timeoutMs: 120,
      },
      {
        runOperation: () => {
          polls += 1;
          // First poll answers; the second hangs the way a stalled connection would.
          return polls === 1 ? Promise.resolve(env("queued")) : new Promise<Envelope>(() => {});
        },
      },
    );

    expect(polls).toBe(2);
    expect(result.exitCode).toBe(ExitCode.TransientExhausted);
    expect(result.env.ok).toBe(false);
    if (!result.env.ok) expect(result.env.error.code).toBe("wait_timeout");
    const raw = errorRaw(result.env);
    expect(raw.poll_abandoned).toBe(true);
    // The last real observation survives the abandoned poll.
    expect(raw.status).toBe("queued");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("awaits the first operation poll instead of abandoning it", async () => {
    let polls = 0;
    const result = await waitForOperation(
      {
        operation: "get_dubbing",
        json: "{}",
        statusPath: "data.status",
        success: "done",
        timeoutMs: 1,
      },
      {
        runOperation: async () => {
          polls += 1;
          await new Promise((resolve) => setTimeout(resolve, 60));
          return env("processing");
        },
      },
    );

    // A create-then-wait caller must still learn the real status of a paid job.
    expect(polls).toBe(1);
    expect(result.exitCode).toBe(ExitCode.TransientExhausted);
    expect(errorRaw(result.env).status).toBe("processing");
  });

  it("rejects an operation success observed after the deadline", async () => {
    let now = 0;
    const result = await waitForOperation(
      {
        operation: "get_dubbing",
        json: "{}",
        statusPath: "data.status",
        success: "done",
        timeoutMs: 100,
      },
      {
        now: () => now,
        sleep: async () => undefined,
        runOperation: async () => {
          now += 500;
          return env("done");
        },
      },
    );

    expect(result.exitCode).toBe(ExitCode.TransientExhausted);
    expect(result.env.ok).toBe(false);
    if (!result.env.ok) expect(result.env.error.code).toBe("wait_timeout");
  });
});
