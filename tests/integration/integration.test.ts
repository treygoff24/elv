import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CliResult } from "../helpers/cli-result";

const CALL_TIMEOUT_MS = 30_000;
const HAS_API_KEY = Boolean(process.env.ELEVENLABS_API_KEY);

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

function assertNoKeyLeak(stdout: string, stderr: string, apiKey: string): void {
  expect(stdout).not.toContain(apiKey);
  expect(stderr).not.toContain(apiKey);
}

describe.skipIf(!HAS_API_KEY)("integration (live API, read-only)", () => {
  let cacheDir: string;
  const apiKey = process.env.ELEVENLABS_API_KEY ?? "";

  // Async spawn (NOT spawnSync): keep the event loop free for child I/O.
  function runElv(args: string[]): Promise<CliResult> {
    return new Promise((resolve, reject) => {
      const child = spawn("npx", ["tsx", "src/cli.ts", ...args], {
        env: {
          ...process.env,
          ELEVENLABS_API_KEY: apiKey,
          ELV_CACHE_DIR: cacheDir,
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

  beforeAll(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-integration-cache-"));
  });

  afterAll(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it(
    "models list returns ok envelope",
    async () => {
      const { stdout, stderr, code } = await runElv(["models", "list"]);

      expect(code).toBe(0);
      assertNoKeyLeak(stdout, stderr, apiKey);

      const envelope = parseEnvelope(stdout);
      expect(envelope.ok).toBe(true);
      expect(envelope.data).toBeTruthy();
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "voices list returns ok envelope",
    async () => {
      const { stdout, stderr, code } = await runElv(["voices", "list"]);

      expect(code).toBe(0);
      assertNoKeyLeak(stdout, stderr, apiKey);

      const envelope = parseEnvelope(stdout);
      expect(envelope.ok).toBe(true);
      expect(envelope.operation_id).toBe("get_user_voices_v2");
      // v2 voice objects are rich, so a default page may spill to disk instead of
      // inlining: accept either inline data or a spilled file + summary.
      const hasInline = envelope.data !== undefined && envelope.data !== null;
      const hasFiles = Array.isArray(envelope.files) && envelope.files.length > 0;
      expect(hasInline || hasFiles).toBe(true);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "ops search finds text-to-speech operations",
    async () => {
      const { stdout, stderr, code } = await runElv([
        "ops",
        "search",
        "text to speech",
        "--limit",
        "5",
      ]);

      expect(code).toBe(0);
      assertNoKeyLeak(stdout, stderr, apiKey);

      const envelope = parseEnvelope(stdout);
      expect(envelope.ok).toBe(true);

      const data = envelope.data as Record<string, unknown>;
      const results = data.results ?? data;
      expect(Array.isArray(results)).toBe(true);
      expect((results as unknown[]).length).toBeGreaterThan(0);
    },
    CALL_TIMEOUT_MS,
  );
});
