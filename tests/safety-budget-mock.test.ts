import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const CANARY_KEY = "test_key_CANARY";
const FAKE_AUDIO = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
const CALL_TIMEOUT_MS = 30_000;
const LONG_TTS_TEXT = "x".repeat(200);

interface ElvResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

interface RequestFlags {
  deleteVoice: boolean;
  ttsPost: boolean;
  sfxPost: boolean;
  audioIsolationPost: boolean;
}

function buildMinimalWav(durationSeconds: number, sampleRate = 8000): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = numChannels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const numSamples = Math.max(1, Math.ceil(sampleRate * durationSeconds));
  const dataSize = numSamples * blockAlign;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  return buffer;
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

function errorRecord(envelope: Record<string, unknown>): Record<string, unknown> {
  const error = envelope.error;
  expect(error).toBeTypeOf("object");
  expect(error).not.toBeNull();
  return error as Record<string, unknown>;
}

function dataRecord(envelope: Record<string, unknown>): Record<string, unknown> {
  const data = envelope.data;
  expect(data).toBeTypeOf("object");
  expect(data).not.toBeNull();
  return data as Record<string, unknown>;
}

function costRecord(envelope: Record<string, unknown>): Record<string, unknown> | null {
  const cost = envelope.cost;
  if (cost == null) return null;
  expect(cost).toBeTypeOf("object");
  return cost as Record<string, unknown>;
}

function assertNoKeyLeak(stdout: string, stderr: string): void {
  expect(stdout).not.toContain(CANARY_KEY);
  expect(stderr).not.toContain(CANARY_KEY);
}

describe("safety and budget mock server (black-box, integration gate)", () => {
  let server: Server;
  let baseUrl: string;
  let cacheDir: string;
  let isolateWavPath: string;
  let flags: RequestFlags;

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
    cacheDir = mkdtempSync(join(tmpdir(), "elv-safety-budget-cache-"));
    isolateWavPath = join(tmpdir(), `elv-isolate-${Date.now()}.wav`);
    writeFileSync(isolateWavPath, buildMinimalWav(1));

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

      if (method === "DELETE" && path === "/v1/voices/v1") {
        flags.deleteVoice = true;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      const ttsMatch = path.match(/^\/v1\/text-to-speech\/([^/]+)$/);
      if (method === "POST" && ttsMatch) {
        flags.ttsPost = true;
        await readBody(req);
        res.writeHead(200, {
          "Content-Type": "audio/mpeg",
          "character-cost": "42",
        });
        res.end(FAKE_AUDIO);
        return;
      }

      if (method === "POST" && path === "/v1/sound-generation") {
        flags.sfxPost = true;
        await readBody(req);
        res.writeHead(200, { "Content-Type": "audio/mpeg" });
        res.end(FAKE_AUDIO);
        return;
      }

      if (method === "POST" && path === "/v1/audio-isolation") {
        flags.audioIsolationPost = true;
        await readBody(req);
        res.writeHead(200, { "Content-Type": "audio/mpeg" });
        res.end(FAKE_AUDIO);
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
    rmSync(isolateWavPath, { force: true });
  });

  beforeEach(() => {
    flags = {
      deleteVoice: false,
      ttsPost: false,
      sfxPost: false,
      audioIsolationPost: false,
    };
  });

  it(
    "delete_voice without --yes exits 4 with confirmation code and no DELETE (AC #13/#21)",
    async () => {
      const { stdout, stderr, code } = await runElv([
        "call",
        "delete_voice",
        "--path",
        "voice_id=v1",
      ]);

      expect(code).toBe(4);
      assertNoKeyLeak(stdout, stderr);

      const envelope = parseEnvelope(stdout);
      expect(envelope.ok).toBe(false);
      expect(errorRecord(envelope).code).toBe("confirmation");
      expect(flags.deleteVoice).toBe(false);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "delete_voice with --yes reaches mock DELETE and returns ok (AC #13/#21)",
    async () => {
      const { stdout, stderr, code } = await runElv([
        "call",
        "delete_voice",
        "--path",
        "voice_id=v1",
        "--yes",
      ]);

      expect(code).toBe(0);
      assertNoKeyLeak(stdout, stderr);

      const envelope = parseEnvelope(stdout);
      expect(envelope.ok).toBe(true);
      expect(flags.deleteVoice).toBe(true);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "voices list alias is never gated without --yes (AC #13)",
    async () => {
      const { stdout, stderr, code } = await runElv(["voices", "list"]);

      expect(code).toBe(0);
      assertNoKeyLeak(stdout, stderr);

      const envelope = parseEnvelope(stdout);
      expect(envelope.ok).toBe(true);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "tts over --max-credits exits 5 with budget code and no POST (AC #14)",
    async () => {
      const { stdout, stderr, code } = await runElv([
        "tts",
        "--voice-id",
        "v1",
        "--text",
        LONG_TTS_TEXT,
        "--max-credits",
        "1",
      ]);

      expect(code).toBe(5);
      assertNoKeyLeak(stdout, stderr);

      const envelope = parseEnvelope(stdout);
      expect(envelope.ok).toBe(false);
      expect(errorRecord(envelope).code).toBe("budget");
      expect(flags.ttsPost).toBe(false);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "sfx over --max-credits exits 5 with budget code and no POST (AC #14 B1)",
    async () => {
      const { stdout, stderr, code } = await runElv([
        "sfx",
        "--prompt",
        "door creak",
        "--duration",
        "30",
        "--max-credits",
        "1",
      ]);

      expect(code).toBe(5);
      assertNoKeyLeak(stdout, stderr);

      const envelope = parseEnvelope(stdout);
      expect(envelope.ok).toBe(false);
      expect(errorRecord(envelope).code).toBe("budget");
      expect(flags.sfxPost).toBe(false);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "voice-isolate over --max-credits exits 5 with budget code and no POST (AC #14 B1)",
    async () => {
      const { stdout, stderr, code } = await runElv([
        "voice-isolate",
        "--file",
        isolateWavPath,
        "--max-credits",
        "1",
      ]);

      expect(code).toBe(5);
      assertNoKeyLeak(stdout, stderr);

      const envelope = parseEnvelope(stdout);
      expect(envelope.ok).toBe(false);
      expect(errorRecord(envelope).code).toBe("budget");
      expect(flags.audioIsolationPost).toBe(false);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "generous --max-credits lets tts through to the mock (AC #14)",
    async () => {
      const outDir = mkdtempSync(join(tmpdir(), "elv-safety-budget-out-"));
      try {
        const { stdout, stderr, code } = await runElv([
          "tts",
          "--voice-id",
          "v1",
          "--text",
          "hello",
          "--max-credits",
          "100000000",
          "--out",
          outDir,
        ]);

        expect(code).toBe(0);
        assertNoKeyLeak(stdout, stderr);

        const envelope = parseEnvelope(stdout);
        expect(envelope.ok).toBe(true);
        expect(flags.ttsPost).toBe(true);
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "dry-run delete_voice without --yes previews would_require_yes and hits no network (AC #26)",
    async () => {
      const { stdout, stderr, code } = await runElv([
        "call",
        "delete_voice",
        "--path",
        "voice_id=v1",
        "--dry-run",
      ]);

      expect(code).toBe(0);
      assertNoKeyLeak(stdout, stderr);

      const envelope = parseEnvelope(stdout);
      expect(envelope.ok).toBe(true);
      expect(dataRecord(envelope).dry_run).toBe(true);
      expect(dataRecord(envelope).would_require_yes).toBe(true);
      expect(flags.deleteVoice).toBe(false);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "dry-run tts over budget previews would_exceed_budget and hits no network (AC #26)",
    async () => {
      const { stdout, stderr, code } = await runElv([
        "tts",
        "--voice-id",
        "v1",
        "--text",
        LONG_TTS_TEXT,
        "--max-credits",
        "1",
        "--dry-run",
      ]);

      expect(code).toBe(0);
      assertNoKeyLeak(stdout, stderr);

      const envelope = parseEnvelope(stdout);
      expect(envelope.ok).toBe(true);
      expect(dataRecord(envelope).dry_run).toBe(true);
      expect(dataRecord(envelope).would_exceed_budget).toBe(true);
      expect(flags.ttsPost).toBe(false);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "--retry-post multiplies dry-run tts credit estimate (AC #30)",
    async () => {
      const base = await runElv(["tts", "--voice-id", "v1", "--text", LONG_TTS_TEXT, "--dry-run"]);
      expect(base.code).toBe(0);
      assertNoKeyLeak(base.stdout, base.stderr);

      const retried = await runElv([
        "tts",
        "--voice-id",
        "v1",
        "--text",
        LONG_TTS_TEXT,
        "--dry-run",
        "--retry-post",
      ]);
      expect(retried.code).toBe(0);
      assertNoKeyLeak(retried.stdout, retried.stderr);

      const baseEnvelope = parseEnvelope(base.stdout);
      const retryEnvelope = parseEnvelope(retried.stdout);

      const baseEstimate =
        (costRecord(baseEnvelope)?.credits_estimated as number | null | undefined) ??
        (dataRecord(baseEnvelope).credits_estimated as number | null | undefined);
      const retryEstimate =
        (costRecord(retryEnvelope)?.credits_estimated as number | null | undefined) ??
        (dataRecord(retryEnvelope).credits_estimated as number | null | undefined);

      expect(typeof baseEstimate).toBe("number");
      expect(typeof retryEstimate).toBe("number");
      expect(retryEstimate!).toBeGreaterThan(baseEstimate!);
      expect(retryEstimate! % baseEstimate!).toBe(0);
      expect(flags.ttsPost).toBe(false);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "API key never appears in stdout or stderr (AC #15)",
    async () => {
      const confirmation = await runElv(["call", "delete_voice", "--path", "voice_id=v1"]);
      assertNoKeyLeak(confirmation.stdout, confirmation.stderr);

      const budget = await runElv([
        "tts",
        "--voice-id",
        "v1",
        "--text",
        LONG_TTS_TEXT,
        "--max-credits",
        "1",
      ]);
      assertNoKeyLeak(budget.stdout, budget.stderr);
    },
    CALL_TIMEOUT_MS,
  );
});
