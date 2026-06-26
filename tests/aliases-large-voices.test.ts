import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CANARY_KEY = "test_key_CANARY";
const FAKE_AUDIO = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
const CALL_TIMEOUT_MS = 30_000;
const ROGER = "Roger - Laid-Back, Casual, Resonant";

interface ElvResult {
  stdout: string;
  stderr: string;
  code: number | null;
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
  const parsed = JSON.parse(stdout.trim()) as unknown;
  expect(parsed).toBeTypeOf("object");
  expect(parsed).not.toBeNull();
  return parsed as Record<string, unknown>;
}

function largeVoices(): Record<string, unknown> {
  return {
    voices: Array.from({ length: 35 }, (_, index) => ({
      voice_id: index === 7 ? "roger" : `voice_${index}`,
      name: index === 7 ? ROGER : `Voice ${index}`,
      description: "x".repeat(1200),
    })),
  };
}

describe("aliases resolve large get_voices responses", () => {
  let server: Server;
  let baseUrl: string;
  let cacheDir: string;
  let ttsVoiceId: string | null = null;

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
    cacheDir = mkdtempSync(join(tmpdir(), "elv-large-voices-cache-"));
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/v1/voices") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(largeVoices()));
        return;
      }

      const ttsMatch = url.pathname.match(/^\/v1\/text-to-speech\/([^/]+)$/);
      if (method === "POST" && ttsMatch) {
        ttsVoiceId = ttsMatch[1] ?? null;
        await readBody(req);
        res.writeHead(200, { "Content-Type": "audio/mpeg", "character-cost": "2" });
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
    if (addr === null || typeof addr === "string") throw new Error("failed to bind mock server");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it(
    "voices find filters matches from a spilled-size get_voices response",
    async () => {
      const { stdout, stderr, code } = await runElv(["voices", "find", "Roger"]);

      expect(code).toBe(0);
      expect(stdout).not.toContain(CANARY_KEY);
      expect(stderr).not.toContain(CANARY_KEY);
      const envelope = parseEnvelope(stdout);
      expect(envelope.ok).toBe(true);
      const data = envelope.data as { voices?: Array<{ voice_id?: string; name?: string }> };
      expect(data.voices).toEqual([{ voice_id: "roger", name: ROGER, description: expect.any(String) }]);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "tts --voice resolves an exact name from a spilled-size get_voices response",
    async () => {
      const outDir = mkdtempSync(join(tmpdir(), "elv-large-voices-tts-"));
      try {
        const { stdout, stderr, code } = await runElv([
          "tts",
          "--voice",
          ROGER,
          "--text",
          "Hi",
          "--out",
          outDir,
        ]);

        expect(code).toBe(0);
        expect(stdout).not.toContain("No voice named");
        expect(stderr).not.toContain(CANARY_KEY);
        expect(ttsVoiceId).toBe("roger");
        const envelope = parseEnvelope(stdout);
        expect(envelope.ok).toBe(true);
        const files = envelope.files as Array<{ path: string }>;
        expect(existsSync(files[0]!.path)).toBe(true);
        expect(readFileSync(files[0]!.path)).toEqual(FAKE_AUDIO);
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    },
    CALL_TIMEOUT_MS,
  );
});
