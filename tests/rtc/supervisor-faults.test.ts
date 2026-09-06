import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";

const mocks = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock("node:child_process", () => ({ fork: mocks.fork }));
import { RtcSessionError, runRtcSession } from "../../src/rtc/session";

describe("RTC supervisor fault injection (not native transport proof)", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("classifies startup IPC failure only after observing owned worker exit and keeps logs secret-safe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elv-rtc-ipc-fault-"));
    directories.push(dir);
    const token = "LOCAL_WORKER_FAILURE_CREDENTIAL";
    const child = Object.assign(new EventEmitter(), {
      connected: false,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      unref: vi.fn(),
      disconnect: vi.fn(),
      send: vi.fn(),
    });
    let exitObserved = false;
    mocks.fork.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.write(`diagnostic ${token.slice(0, 15)}`);
        child.stderr.write("different-stream diagnostic\n");
        child.stdout.write(`${token.slice(15)}\n`);
        exitObserved = true;
        child.emit("close", 1);
      });
      return child as unknown as ChildProcess;
    });
    const result = await runRtcSession({
      serverUrl: "ws://127.0.0.1:9",
      token,
      outDir: dir,
      script: [],
      timeoutMs: 100,
    }).catch((error: unknown) => error);
    expect(exitObserved).toBe(true);
    expect(result).toBeInstanceOf(RtcSessionError);
    const error = result as RtcSessionError;
    expect(error.code).toBe("rtc_worker_error");
    expect(error.rtc.closed).toBe(true);
    expect(error.message).not.toContain(token);
    expect(error.message).not.toContain(token.slice(0, 15));
    expect(error.message).toContain("different-stream diagnostic");
    expect(child.kill).not.toHaveBeenCalled();
    child.stdout.destroy();
    child.stderr.destroy();
  });
});
