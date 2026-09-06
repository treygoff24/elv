import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { parseEnvelope, recordValue } from "../helpers/cli-result";

// The stderr pipe buffer is 64 KiB on Linux; the payload has to exceed it several
// times over so that a consumer which starts late cannot have drained it early.
const EVENT_COUNT = 400;
const PAD = "x".repeat(480);
const FINAL_MARKER = "FINAL_MARKER";
const CONSUMER_DELAY_MS = 3_000;
const TEST_TIMEOUT_MS = 60_000;

describe("ws duplex stderr backpressure", () => {
  let wss: WebSocketServer;
  let wsPort: number;
  let cacheDir: string;
  let onConnection: (() => void) | undefined;

  beforeAll(async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-ws-bp-cache-"));
    wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
    const address = wss.address();
    if (address === null || typeof address === "string") throw new Error("failed to bind mock ws");
    wsPort = address.port;

    wss.on("connection", (socket: WebSocket) => {
      onConnection?.();
      for (let index = 1; index <= EVENT_COUNT; index += 1) {
        const payload = {
          type: "agent_response",
          index,
          pad: PAD,
          ...(index === EVENT_COUNT ? { marker: FINAL_MARKER } : {}),
        };
        const isLast = index === EVENT_COUNT;
        socket.send(JSON.stringify(payload), () => {
          if (isLast) socket.close(1000, "mock done");
        });
      }
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      wss.close((error) => (error ? reject(error) : resolve()));
    });
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it(
    "delivers every duplex event to a consumer that starts draining stderr late",
    async () => {
      const outDir = mkdtempSync(join(tmpdir(), "elv-ws-bp-out-"));
      try {
        const { stdout, stderr, code } = await runWithLateStderrConsumer([
          "ws",
          "convai",
          "--duplex",
          "--yes",
          "--query",
          "agent_id=slow-consumer",
          "--base-url",
          `http://127.0.0.1:${wsPort}`,
          "--out",
          outDir,
          "--timeout-ms",
          "20000",
        ]);

        expect(code).toBe(0);
        const envelope = parseEnvelope(stdout);
        expect(envelope.ok).toBe(true);
        const ws = recordValue(envelope.ws, "ws");
        expect(ws.events_received).toBe(EVENT_COUNT);

        const lines = stderr.split("\n").filter((line) => line.trim().length > 0);
        expect(lines).toHaveLength(EVENT_COUNT);
        expect(lines.at(-1)).toContain(FINAL_MARKER);
        const indexes = lines.map(
          (line) => (JSON.parse(line) as { index?: number }).index ?? null,
        );
        expect(indexes).toEqual(Array.from({ length: EVENT_COUNT }, (_, i) => i + 1));
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  function runWithLateStderrConsumer(
    args: string[],
  ): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
        env: { ...process.env, ELEVENLABS_API_KEY: "test_key_CANARY", ELV_CACHE_DIR: cacheDir },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      // The point of the test: stderr stays unread (and its pipe buffer full) until
      // long after the provider has streamed every event. The delay is measured from
      // the WebSocket connection, so a slow CLI start cannot shorten the unread window.
      let consumer: NodeJS.Timeout | undefined;
      onConnection = () => {
        consumer = setTimeout(() => {
          child.stderr.on("data", (chunk: Buffer | string) => {
            stderr += chunk.toString();
          });
        }, CONSUMER_DELAY_MS);
        consumer.unref();
      };
      child.on("error", reject);
      child.on("close", (code: number | null) => {
        if (consumer) clearTimeout(consumer);
        onConnection = undefined;
        child.stdin.destroy();
        resolve({ stdout, stderr, code });
      });
    });
  }
});
