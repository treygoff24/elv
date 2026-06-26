import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CANARY_KEY = "test_key_CANARY";
const FAKE_AUDIO = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
const CALL_TIMEOUT_MS = 30_000;

const USAGE_FROM_MS = Date.parse("2026-06-01");
const USAGE_TO_MS = Date.parse("2026-06-25");

interface ElvResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

interface CharacterStatsQuery {
  start_unix: string | null;
  end_unix: string | null;
}

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

function filesArray(envelope: Record<string, unknown>): Record<string, unknown>[] {
  const files = envelope.files;
  expect(Array.isArray(files)).toBe(true);
  return files as Record<string, unknown>[];
}

function assertNoKeyLeak(stdout: string, stderr: string): void {
  expect(stdout).not.toContain(CANARY_KEY);
  expect(stderr).not.toContain(CANARY_KEY);
}

function assertSingleEnvelope(stdout: string): Record<string, unknown> {
  const envelope = parseEnvelope(stdout);
  expect(envelope.v).toBe(1);
  return envelope;
}

function assertOkEnvelope(stdout: string, stderr: string): Record<string, unknown> {
  assertNoKeyLeak(stdout, stderr);
  const envelope = assertSingleEnvelope(stdout);
  expect(envelope.ok).toBe(true);
  return envelope;
}

function historyItems(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({
    history_item_id: `hist_${index + 1}`,
    text: `item ${index + 1}`,
  }));
}

describe("aliases mock server (black-box, integration gate)", () => {
  let server: Server;
  let baseUrl: string;
  let cacheDir: string;
  let lastCharacterStatsQuery: CharacterStatsQuery | null = null;

  // Async spawn (NOT spawnSync): the mock server runs in THIS process, so the event
  // loop must stay free to service the spawned CLI's request — spawnSync would deadlock.
  function runElv(args: string[], env?: Record<string, string>): Promise<ElvResult> {
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
    cacheDir = mkdtempSync(join(tmpdir(), "elv-aliases-cache-"));

    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = req.method ?? "GET";
      const path = url.pathname;

      if (method === "GET" && path === "/v2/voices") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            voices: [{ voice_id: "v1", name: "Rachel" }],
          }),
        );
        return;
      }

      if (method === "GET" && path === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify([
            { model_id: "eleven_v3", name: "Eleven v3" },
            { model_id: "eleven_flash_v2_5", name: "Eleven Flash v2.5" },
          ]),
        );
        return;
      }

      if (method === "GET" && path === "/v1/history") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            history: historyItems(20),
            has_more: false,
          }),
        );
        return;
      }

      if (method === "GET" && path === "/v1/user/subscription") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            tier: "creator",
            character_count: 42_000,
            character_limit: 100_000,
          }),
        );
        return;
      }

      if (method === "GET" && path === "/v1/usage/character-stats") {
        lastCharacterStatsQuery = {
          start_unix: url.searchParams.get("start_unix"),
          end_unix: url.searchParams.get("end_unix"),
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            time: [],
            usage: { All: [] },
          }),
        );
        return;
      }

      const ttsMatch = path.match(/^\/v1\/text-to-speech\/([^/]+)$/);
      if (method === "POST" && ttsMatch) {
        await readBody(req);
        res.writeHead(200, { "Content-Type": "audio/mpeg" });
        res.end(FAKE_AUDIO);
        return;
      }

      if (method === "POST" && path === "/v1/sound-generation") {
        await readBody(req);
        res.writeHead(200, { "Content-Type": "audio/mpeg" });
        res.end(FAKE_AUDIO);
        return;
      }

      const dubbingMatch = path.match(/^\/v1\/dubbing\/([^/]+)$/);
      if (method === "GET" && dubbingMatch) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            dubbing_id: dubbingMatch[1],
            status: "dubbed",
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
    "tts saves audio to --out and prints one ok envelope (AC #9)",
    async () => {
      const outDir = mkdtempSync(join(tmpdir(), "elv-aliases-tts-"));
      try {
        const { stdout, stderr, code } = await runElv([
          "tts",
          "--voice-id",
          "v1",
          "--text",
          "Hi",
          "--out",
          outDir,
        ]);

        expect(code).toBe(0);
        const envelope = assertOkEnvelope(stdout, stderr);

        const files = filesArray(envelope);
        expect(files.length).toBe(1);
        const filePath = files[0]!.path as string;
        expect(existsSync(filePath)).toBe(true);
        expect(statSync(filePath).size).toBeGreaterThan(0);
        expect(readFileSync(filePath).equals(FAKE_AUDIO)).toBe(true);
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "voices list returns ok envelope with voices data",
    async () => {
      const { stdout, stderr, code } = await runElv(["voices", "list"]);

      expect(code).toBe(0);
      const envelope = assertOkEnvelope(stdout, stderr);
      const data = envelope.data as Record<string, unknown>;
      const voices = data.voices ?? envelope.data;
      expect(Array.isArray(voices)).toBe(true);
      expect((voices as unknown[]).length).toBeGreaterThan(0);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "models list returns ok envelope with model data",
    async () => {
      const { stdout, stderr, code } = await runElv(["models", "list"]);

      expect(code).toBe(0);
      const envelope = assertOkEnvelope(stdout, stderr);
      expect(envelope.data).toBeTruthy();
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "history list returns ok envelope with history items",
    async () => {
      const { stdout, stderr, code } = await runElv(["history", "list"]);

      expect(code).toBe(0);
      const envelope = assertOkEnvelope(stdout, stderr);
      const data = envelope.data as Record<string, unknown>;
      const history = data.history ?? envelope.data;
      expect(Array.isArray(history)).toBe(true);
      expect((history as unknown[]).length).toBe(20);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "usage with no args reads subscription",
    async () => {
      const { stdout, stderr, code } = await runElv(["usage"]);

      expect(code).toBe(0);
      assertOkEnvelope(stdout, stderr);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "usage --from/--to sends start_unix/end_unix in milliseconds (AC #27)",
    async () => {
      lastCharacterStatsQuery = null;

      const { stdout, stderr, code } = await runElv([
        "usage",
        "--from",
        "2026-06-01",
        "--to",
        "2026-06-25",
      ]);

      expect(code).toBe(0);
      assertOkEnvelope(stdout, stderr);

      expect(lastCharacterStatsQuery).not.toBeNull();
      const { start_unix, end_unix } = lastCharacterStatsQuery!;

      expect(start_unix).not.toBeNull();
      expect(end_unix).not.toBeNull();

      const startMs = Number(start_unix);
      const endMs = Number(end_unix);

      expect(Number.isFinite(startMs)).toBe(true);
      expect(Number.isFinite(endMs)).toBe(true);

      // Milliseconds, not seconds — values must be >= 1e12 (2026 epoch ms).
      expect(startMs).toBeGreaterThanOrEqual(1_000_000_000_000);
      expect(endMs).toBeGreaterThanOrEqual(1_000_000_000_000);
      expect(startMs).toBeLessThan(10_000_000_000_000);
      expect(endMs).toBeLessThan(10_000_000_000_000);

      expect(startMs).toBe(USAGE_FROM_MS);
      expect(endMs).toBe(USAGE_TO_MS);

      // Regression guard: seconds form would be three orders of magnitude smaller.
      expect(startMs).not.toBe(Math.floor(USAGE_FROM_MS / 1000));
      expect(endMs).not.toBe(Math.floor(USAGE_TO_MS / 1000));
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "sfx saves generated audio to --out",
    async () => {
      const outDir = mkdtempSync(join(tmpdir(), "elv-aliases-sfx-"));
      try {
        const { stdout, stderr, code } = await runElv([
          "sfx",
          "--prompt",
          "door creak",
          "--duration",
          "3",
          "--out",
          outDir,
        ]);

        expect(code).toBe(0);
        const envelope = assertOkEnvelope(stdout, stderr);

        const files = filesArray(envelope);
        expect(files.length).toBe(1);
        const filePath = files[0]!.path as string;
        expect(existsSync(filePath)).toBe(true);
        expect(readFileSync(filePath).equals(FAKE_AUDIO)).toBe(true);
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "dubbing get returns ok envelope with dubbing metadata",
    async () => {
      const { stdout, stderr, code } = await runElv(["dubbing", "get", "--id", "abc"]);

      expect(code).toBe(0);
      const envelope = assertOkEnvelope(stdout, stderr);
      const data = envelope.data as Record<string, unknown>;
      expect(data.dubbing_id).toBe("abc");
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "API key never appears in stdout or stderr (AC #15)",
    async () => {
      const voices = await runElv(["voices", "list"]);
      assertNoKeyLeak(voices.stdout, voices.stderr);

      const usage = await runElv(["usage", "--from", "2026-06-01", "--to", "2026-06-25"]);
      assertNoKeyLeak(usage.stdout, usage.stderr);
    },
    CALL_TIMEOUT_MS,
  );
});
