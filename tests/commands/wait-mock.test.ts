import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CliResult } from "../helpers/cli-result";

const CANARY_KEY = "test_key_CANARY";
const CALL_TIMEOUT_MS = 30_000;
const PROCESSING_POLLS = 3;

function parseEnvelope(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  expect(trimmed.length).toBeGreaterThan(0);
  const parsed: unknown = JSON.parse(trimmed);
  expect(parsed).toBeTypeOf("object");
  expect(parsed).not.toBeNull();
  return parsed as Record<string, unknown>;
}

function errorRecord(envelope: Record<string, unknown>): Record<string, unknown> {
  const error = envelope.error;
  expect(error).toBeTypeOf("object");
  expect(error).not.toBeNull();
  return error as Record<string, unknown>;
}

describe("wait mock server (black-box, integration gate)", () => {
  let server: Server;
  let baseUrl: string;
  let cacheDir: string;
  let pollCount = 0;
  let failureMode = false;

  // Async spawn (NOT spawnSync): the mock server runs in THIS process, so the event
  // loop must stay free to service the spawned CLI's request — spawnSync would deadlock.
  function runElv(args: string[], env?: Record<string, string>): Promise<CliResult> {
    return new Promise((resolve, reject) => {
      const child = spawn("npx", ["tsx", "src/cli.ts", ...args], {
        env: {
          ...process.env,
          ELEVENLABS_BASE_URL: baseUrl,
          ELEVENLABS_API_KEY: CANARY_KEY,
          ELV_CACHE_DIR: cacheDir,
          ...env,
        },
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code: number | null) => resolve({ stdout, stderr, code }));
    });
  }

  function waitArgs(extra: string[] = []): string[] {
    return [
      "wait",
      "--operation",
      "get_speech_history",
      "--json",
      "{}",
      "--status-path",
      "$.data.status",
      "--success",
      "done",
      "--failure",
      "failed",
      "--interval-ms",
      "50",
      ...extra,
    ];
  }

  beforeAll(async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-wait-cache-"));

    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = req.method ?? "GET";
      const path = url.pathname;

      if (method === "GET" && path === "/v1/history") {
        pollCount += 1;

        let status: string;
        if (failureMode) {
          status = pollCount >= 2 ? "failed" : "processing";
        } else if (pollCount <= PROCESSING_POLLS) {
          status = "processing";
        } else {
          status = "done";
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status,
            history: [{ history_item_id: `item_${pollCount}` }],
            has_more: false,
          }),
        );
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ detail: "not found" }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const addr = server.address();
    if (addr === null || typeof addr === "string") {
      throw new Error("failed to bind mock server");
    }
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it(
    "polls until --success value and emits one ok envelope (AC #24)",
    async () => {
      pollCount = 0;
      failureMode = false;

      const { stdout, code } = await runElv(waitArgs(["--timeout-ms", "5000"]));

      expect(code).toBe(0);
      expect(pollCount).toBeGreaterThan(PROCESSING_POLLS);

      const envelope = parseEnvelope(stdout);
      expect(envelope.ok).toBe(true);
      expect(envelope.v).toBe(1);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "resolves with nonzero exit on --failure value",
    async () => {
      pollCount = 0;
      failureMode = true;

      const { stdout, code } = await runElv(waitArgs(["--timeout-ms", "5000"]));

      expect(code).not.toBe(0);

      const envelope = parseEnvelope(stdout);
      expect(envelope.ok).toBe(false);
      const error = errorRecord(envelope);
      expect(String(error.message ?? error.code)).toMatch(/fail/i);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "times out with nonzero exit when resolution exceeds --timeout-ms",
    async () => {
      pollCount = 0;
      failureMode = false;

      const { stdout, code } = await runElv(waitArgs(["--timeout-ms", "100"]));

      expect(code).not.toBe(0);

      const envelope = parseEnvelope(stdout);
      expect(envelope.ok).toBe(false);
      const error = errorRecord(envelope);
      // The stable contract is the error code (wait_timeout); the prose says "Timed out".
      expect(String(error.code)).toMatch(/timeout/i);
      expect(String(error.message)).toMatch(/timed out/i);
    },
    CALL_TIMEOUT_MS,
  );
});
