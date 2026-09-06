import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRtcActions, runRtcSession } from "../../src/rtc/session";

describe("RTC supervisor preflight and input ownership", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "elv-rtc-supervisor-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("proves output writability before any signaling connection", async () => {
    let upgrades = 0;
    const server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    server.on("upgrade", (_req, socket) => {
      upgrades += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No local port");
    try {
      const invalid = join(dir, "occupied");
      writeFileSync(invalid, "preserve");
      await expect(
        runRtcSession({
          serverUrl: `ws://127.0.0.1:${address.port}`,
          token: "no-network-token",
          outDir: invalid,
          script: [],
          timeoutMs: 100,
        }),
      ).rejects.toThrow();
      expect(upgrades).toBe(0);
      expect(readdirSync(dir)).toEqual(["occupied"]);
      if (process.platform !== "win32" && process.getuid?.() !== 0) {
        chmodSync(dir, 0o500);
        try {
          await expect(
            runRtcSession({
              serverUrl: `ws://127.0.0.1:${address.port}`,
              token: "no-network-token",
              outDir: dir,
              script: [],
              timeoutMs: 100,
            }),
          ).rejects.toThrow();
          expect(upgrades).toBe(0);
        } finally {
          chmodSync(dir, 0o700);
        }
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("detaches its own input listeners when the session ends with stdin still open", async () => {
    const input = new PassThrough();
    const abort = new AbortController();
    const iterator = readRtcActions(input, abort.signal);
    const waiting = iterator.next();
    expect(input.listenerCount("data")).toBe(1);
    abort.abort();
    expect(await waiting).toEqual({ done: true, value: undefined });
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
    expect(input.listenerCount("error")).toBe(0);
    expect(input.destroyed).toBe(false);
    input.destroy();
  });

  it("rejects an oversized unterminated duplex line without loading native code", async () => {
    const input = new PassThrough();
    const iterator = readRtcActions(input, new AbortController().signal);
    const next = iterator.next();
    input.write("x".repeat(1024 * 1024 + 1));
    await expect(next).rejects.toThrow(/1 MiB/);
    expect(input.listenerCount("data")).toBe(0);
    input.destroy();
  });

  it("does not reflect secret excerpts from malformed duplex JSON", async () => {
    const input = new PassThrough();
    const next = readRtcActions(input, new AbortController().signal).next();
    input.end('\n\n{"password":"MALFORMED_SECRET_CANARY",broken}\n');
    const result = await next.catch((error: Error) => error);
    expect(result).toBeInstanceOf(Error);
    expect(String(result)).toContain("line 3");
    expect(String(result)).not.toContain("MALFORMED_SECRET_CANARY");
  });

  it("settles a destroyed input stream without waiting for session expiry", async () => {
    const input = new PassThrough();
    const next = readRtcActions(input, new AbortController().signal).next();
    input.destroy();
    expect(await next).toEqual({ done: true, value: undefined });
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("close")).toBe(0);
  });
});
