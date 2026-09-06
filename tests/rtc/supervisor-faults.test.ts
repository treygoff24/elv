import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";

const mocks = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock("node:child_process", () => ({ fork: mocks.fork }));
import { RtcSessionError, runRtcSession } from "../../src/rtc/session";
import { emptyRtcInfo } from "../../src/rtc/types";

describe("RTC supervisor fault injection (not native transport proof)", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("authors an authoritative partial manifest after a post-receipt worker failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elv-rtc-final-receipt-"));
    directories.push(dir);
    const pcm = Buffer.from([1, 0, 2, 0, 3, 0]);
    const child = Object.assign(new EventEmitter(), {
      connected: true,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      unref: vi.fn(),
      disconnect: vi.fn(),
      send: vi.fn((message, callback: (error: Error | null) => void) => {
        callback(null);
        setImmediate(() => {
          const path = join(message.options.outDir, "audio-1.pcm");
          writeFileSync(path, pcm);
          const file = {
            path,
            mime: "audio/pcm",
            bytes: pcm.length,
            sha256: createHash("sha256").update(pcm).digest("hex"),
          };
          const rtc = {
            ...emptyRtcInfo(),
            closed: true,
            reason: "closed",
            audio_output_bytes: pcm.length,
          };
          child.emit("message", { type: "result", result: { rtc, files: [file] } });
          child.emit("close", 1, null);
        });
      }),
    });
    mocks.fork.mockReturnValue(child as unknown as ChildProcess);
    const result = await runRtcSession({
      serverUrl: "ws://127.0.0.1:9",
      token: "canary",
      outDir: dir,
      script: [],
      timeoutMs: 1000,
    }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(RtcSessionError);
    const error = result as RtcSessionError;
    expect(error.code).toBe("rtc_worker_error");
    const manifest = error.files.find((file) => file.mime === "application/json");
    expect(manifest).toBeDefined();
    const bytes = readFileSync(manifest!.path);
    expect(manifest).toMatchObject({
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      partial: true,
    });
    expect(JSON.parse(bytes.toString("utf8"))).toEqual({
      rtc: error.rtc,
      files: error.files.filter((file) => file.path !== manifest!.path),
    });
    expect(error.rtc).toMatchObject({ closed: true, partial: true });
    expect(readFileSync(error.files.find((file) => file.mime === "audio/pcm")!.path)).toEqual(pcm);
    child.stdout.destroy();
    child.stderr.destroy();
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

  it.each([
    [1, null],
    [null, "SIGKILL"],
  ] as const)(
    "rejects a success receipt followed by abnormal worker exit: code=%s signal=%s",
    async (code, signal) => {
      const dir = mkdtempSync(join(tmpdir(), "elv-rtc-late-fault-"));
      directories.push(dir);
      const child = Object.assign(new EventEmitter(), {
        connected: true,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(),
        unref: vi.fn(),
        disconnect: vi.fn(),
        send: vi.fn((_message, callback: (error: Error | null) => void) => {
          callback(null);
          setImmediate(() => {
            child.emit("message", {
              type: "result",
              result: { rtc: { ...emptyRtcInfo(), closed: true, reason: "closed" }, files: [] },
            });
            child.emit("close", code, signal);
          });
        }),
      });
      mocks.fork.mockReturnValue(child as unknown as ChildProcess);
      const result = await runRtcSession({
        serverUrl: "ws://127.0.0.1:9",
        token: "canary",
        outDir: dir,
        script: [],
        timeoutMs: 1000,
      }).catch((error: unknown) => error);
      expect(result).toBeInstanceOf(RtcSessionError);
      const error = result as RtcSessionError;
      expect(error.code).toBe("rtc_worker_error");
      expect(error.rtc).toMatchObject({ closed: true, partial: true });
      expect(child.kill).not.toHaveBeenCalled();
      child.stdout.destroy();
      child.stderr.destroy();
    },
  );

  it("allows a graceful worker to finish cleanup without premature termination", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elv-rtc-slow-exit-"));
    directories.push(dir);
    let delayedExit: NodeJS.Timeout | undefined;
    const child = Object.assign(new EventEmitter(), {
      connected: true,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      unref: vi.fn(),
      disconnect: vi.fn(),
      send: vi.fn((_message, callback: (error: Error | null) => void) => {
        callback(null);
        setImmediate(() => {
          child.emit("message", {
            type: "result",
            result: { rtc: { ...emptyRtcInfo(), closed: true, reason: "closed" }, files: [] },
          });
          delayedExit = setTimeout(() => child.emit("close", 0, null), 2000);
        });
      }),
    });
    mocks.fork.mockReturnValue(child as unknown as ChildProcess);
    try {
      await expect(
        runRtcSession({
          serverUrl: "ws://127.0.0.1:9",
          token: "canary",
          outDir: dir,
          script: [],
          timeoutMs: 10_000,
        }),
      ).resolves.toMatchObject({ rtc: { closed: true, partial: false } });
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      if (delayedExit) clearTimeout(delayedExit);
      child.stdout.destroy();
      child.stderr.destroy();
    }
  });

  it("returns a bounded cleanup failure when the worker ignores both termination signals", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elv-rtc-hung-exit-"));
    directories.push(dir);
    const child = Object.assign(new EventEmitter(), {
      connected: true,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      unref: vi.fn(),
      disconnect: vi.fn(),
      send: vi.fn((_message, callback: (error: Error | null) => void) => callback(null)),
    });
    mocks.fork.mockReturnValue(child as unknown as ChildProcess);
    const result = await runRtcSession({
      serverUrl: "ws://127.0.0.1:9",
      token: "canary",
      outDir: dir,
      script: [],
      timeoutMs: 10,
    }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(RtcSessionError);
    expect((result as RtcSessionError).code).toBe("rtc_cleanup_incomplete");
    expect((result as RtcSessionError).rtc.closed).toBe(false);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(child.unref).toHaveBeenCalledOnce();
    child.stdout.destroy();
    child.stderr.destroy();
  });
});
