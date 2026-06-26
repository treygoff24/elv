import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CliResult } from "../helpers/cli-result";

const CANARY_KEY = "test_key_CANARY";
const FAKE_AUDIO = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
// npx tsx cold-start + first-call registry compile from the snapshot need headroom.
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

function errorRecord(envelope: Record<string, unknown>): Record<string, unknown> {
  const error = envelope.error;
  expect(error).toBeTypeOf("object");
  expect(error).not.toBeNull();
  return error as Record<string, unknown>;
}

function filesArray(envelope: Record<string, unknown>): Record<string, unknown>[] {
  const files = envelope.files;
  expect(Array.isArray(files)).toBe(true);
  return files as Record<string, unknown>[];
}

function assertNoKeyLeak(stdout: string, stderr: string): void {
  expect(stdout).not.toContain(CANARY_KEY);
  expect(stderr).not.toContain(CANARY_KEY);
}

describe("call mock server (black-box, integration gate)", () => {
  let server: Server;
  let baseUrl: string;
  let cacheDir: string;

  // Async spawn (NOT spawnSync): the mock server runs in THIS process, so the event
  // loop must stay free to service the spawned CLI's request — spawnSync would deadlock.
  function runCall(args: string[], env?: Record<string, string>): Promise<CliResult> {
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

  function ttsJson(text: string): string {
    return JSON.stringify({ path: { voice_id: "v1" }, body: { text } });
  }

  beforeAll(async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-call-cache-"));

    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = req.method ?? "GET";
      const path = url.pathname;

      if (method === "GET" && path === "/v1/voices") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            voices: [{ voice_id: "v1", name: "Rachel" }],
            unknown_future_field: "ignored",
          }),
        );
        return;
      }

      const ttsMatch = path.match(/^\/v1\/text-to-speech\/([^/]+)$/);
      if (method === "POST" && ttsMatch) {
        const raw = await readBody(req);
        let text: string | undefined;
        try {
          const body = JSON.parse(raw) as { text?: string };
          text = body.text;
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ detail: "bad json" }));
          return;
        }

        switch (text) {
          case "ERR_422_ARRAY":
            res.writeHead(422, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                detail: [{ loc: ["body", "text"], msg: "too short", type: "value_error" }],
              }),
            );
            return;
          case "ERR_RICH":
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                detail: {
                  type: "validation_error",
                  code: "invalid_parameters",
                  message: "bad",
                  param: "text",
                  request_id: "req_1",
                },
              }),
            );
            return;
          case "ERR_LEGACY":
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                detail: { status: "invalid_api_key", message: "Invalid API key" },
              }),
            );
            return;
          case "ERR_STRING":
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ detail: "internal boom" }));
            return;
          case "NOT_FOUND":
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ detail: { status: "voice_not_found", message: "no" } }));
            return;
          default:
            res.writeHead(200, {
              "Content-Type": "audio/mpeg",
              "character-cost": "42",
            });
            res.end(FAKE_AUDIO);
            return;
        }
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
    "GET get_voices returns ok envelope with voices data (AC #8)",
    async () => {
      const { stdout, stderr, code } = await runCall(["call", "get_voices"]);

      expect(code).toBe(0);
      assertNoKeyLeak(stdout, stderr);

      const envelope = parseEnvelope(stdout);
      expect(envelope.v).toBe(1);
      expect(envelope.ok).toBe(true);
      expect(envelope.operation_id).toBe("get_voices");

      const data = envelope.data;
      expect(data).toBeTypeOf("object");
      expect(data).not.toBeNull();

      const record = data as Record<string, unknown>;
      const voices = record.voices ?? data;
      expect(Array.isArray(voices)).toBe(true);
      expect((voices as unknown[]).length).toBeGreaterThan(0);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "binary TTS response is saved to disk, not stdout (AC #9)",
    async () => {
      const outDir = mkdtempSync(join(tmpdir(), "elv-call-out-"));
      try {
        const { stdout, stderr, code } = await runCall([
          "call",
          "text_to_speech_full",
          "--json",
          ttsJson("hello"),
          "--out",
          outDir,
        ]);

        expect(code).toBe(0);
        assertNoKeyLeak(stdout, stderr);

        const envelope = parseEnvelope(stdout);
        expect(envelope.ok).toBe(true);

        const files = filesArray(envelope);
        expect(files.length).toBe(1);

        const file = files[0]!;
        expect(typeof file.mime).toBe("string");
        expect(String(file.mime)).toMatch(/audio/);
        expect(typeof file.path).toBe("string");

        const filePath = file.path as string;
        expect(existsSync(filePath)).toBe(true);
        expect(statSync(filePath).size).toBeGreaterThan(0);
        expect(readFileSync(filePath).equals(FAKE_AUDIO)).toBe(true);

        const cost = envelope.cost;
        if (cost && typeof cost === "object" && cost !== null) {
          const costRecord = cost as Record<string, unknown>;
          if (costRecord.credits_charged != null) {
            expect(costRecord.credits_charged).toBe(42);
          }
        }
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "422 array detail normalizes to validation error with param (AC #11)",
    async () => {
      const { stdout, code } = await runCall([
        "call",
        "text_to_speech_full",
        "--json",
        ttsJson("ERR_422_ARRAY"),
      ]);

      expect(code).toBe(2);

      const envelope = parseEnvelope(stdout);
      expect(envelope.ok).toBe(false);

      const error = errorRecord(envelope);
      expect(String(error.code)).toMatch(/validation/i);
      expect(error.param).toBe("text");
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "rich object detail normalizes invalid_parameters on text param",
    async () => {
      const { stdout, code } = await runCall([
        "call",
        "text_to_speech_full",
        "--json",
        ttsJson("ERR_RICH"),
      ]);

      expect(code).toBe(2);

      const envelope = parseEnvelope(stdout);
      expect(envelope.ok).toBe(false);

      const error = errorRecord(envelope);
      expect(error.code).toBe("invalid_parameters");
      expect(error.param).toBe("text");
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "legacy {status,message} detail maps invalid_api_key to exit 3",
    async () => {
      const { stdout, stderr, code } = await runCall([
        "call",
        "text_to_speech_full",
        "--json",
        ttsJson("ERR_LEGACY"),
      ]);

      expect(code).toBe(3);
      assertNoKeyLeak(stdout, stderr);

      const envelope = parseEnvelope(stdout);
      expect(envelope.ok).toBe(false);

      const error = errorRecord(envelope);
      expect(error.code).toBe("invalid_api_key");
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "bare string detail preserves message with provider/transient exit",
    async () => {
      const { stdout, code } = await runCall([
        "call",
        "text_to_speech_full",
        "--json",
        ttsJson("ERR_STRING"),
      ]);

      expect([7, 8]).toContain(code);

      const envelope = parseEnvelope(stdout);
      expect(envelope.ok).toBe(false);

      const error = errorRecord(envelope);
      expect(String(error.message)).toContain("internal boom");
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "voice_not_found maps to exit 9",
    async () => {
      const { stdout, code } = await runCall([
        "call",
        "text_to_speech_full",
        "--json",
        ttsJson("NOT_FOUND"),
      ]);

      expect(code).toBe(9);

      const envelope = parseEnvelope(stdout);
      expect(envelope.ok).toBe(false);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "API key never appears in stdout or stderr (AC #15)",
    async () => {
      const success = await runCall(["call", "get_voices"]);
      assertNoKeyLeak(success.stdout, success.stderr);

      const failure = await runCall([
        "call",
        "text_to_speech_full",
        "--json",
        ttsJson("ERR_LEGACY"),
      ]);
      assertNoKeyLeak(failure.stdout, failure.stderr);
    },
    CALL_TIMEOUT_MS,
  );
});
