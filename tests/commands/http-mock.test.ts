import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CliResult } from "../helpers/cli-result";

const CANARY_KEY = "test_key_CANARY";
const CALL_TIMEOUT_MS = 30_000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function parseEnvelope(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  expect(trimmed.length).toBeGreaterThan(0);
  expect(trimmed.startsWith("{")).toBe(true);
  expect(trimmed.endsWith("}")).toBe(true);

  const parsed: unknown = JSON.parse(trimmed);
  expect(parsed).toBeTypeOf("object");
  expect(parsed).not.toBeNull();
  expect(Array.isArray(parsed)).toBe(false);

  return parsed as Record<string, unknown>;
}

function assertNoKeyLeak(stdout: string, stderr: string): void {
  expect(stdout).not.toContain(CANARY_KEY);
  expect(stderr).not.toContain(CANARY_KEY);
}

describe("http mock server (black-box, integration gate)", () => {
  let server: Server;
  let baseUrl: string;
  let cacheDir: string;
  let lastPostBody: string | null = null;

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

  beforeAll(async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-http-cache-"));

    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = req.method ?? "GET";
      const path = url.pathname;

      if (method === "GET" && path === "/v1/voices") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            voices: [{ voice_id: "v1", name: "Rachel" }],
          }),
        );
        return;
      }

      if (method === "POST" && path === "/v1/whatever") {
        lastPostBody = await readBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ echoed: true, received: JSON.parse(lastPostBody) }));
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
    "GET /v1/voices returns ok envelope regardless of registry (AC #16)",
    async () => {
      const { stdout, stderr, code } = await runElv(["http", "GET", "/v1/voices"]);

      expect(code).toBe(0);
      assertNoKeyLeak(stdout, stderr);

      const envelope = parseEnvelope(stdout);
      expect(envelope.v).toBe(1);
      expect(envelope.ok).toBe(true);

      const data = envelope.data;
      expect(data).toBeTypeOf("object");
      expect(data).not.toBeNull();

      const record = data as Record<string, unknown>;
      expect(Array.isArray(record.voices)).toBe(true);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "POST echoes --body-json payload to the mock server",
    async () => {
      lastPostBody = null;
      const body = JSON.stringify({ a: 1 });

      const { stdout, stderr, code } = await runElv([
        "http",
        "POST",
        "/v1/whatever",
        "--body-json",
        body,
      ]);

      expect(code).toBe(0);
      assertNoKeyLeak(stdout, stderr);
      expect(lastPostBody).toBe(body);

      const envelope = parseEnvelope(stdout);
      expect(envelope.ok).toBe(true);

      const data = envelope.data as Record<string, unknown>;
      const received = data.received as Record<string, unknown>;
      expect(received.a).toBe(1);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "API key never appears in stdout or stderr",
    async () => {
      const getResult = await runElv(["http", "GET", "/v1/voices"]);
      assertNoKeyLeak(getResult.stdout, getResult.stderr);

      const postResult = await runElv(["http", "POST", "/v1/whatever", "--body-json", '{"a":1}']);
      assertNoKeyLeak(postResult.stdout, postResult.stderr);
    },
    CALL_TIMEOUT_MS,
  );
});
