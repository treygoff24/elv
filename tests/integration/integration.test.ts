import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  arrayValue,
  assertNoKeyLeak,
  parseEnvelope,
  recordValue,
  runCli,
  type CliResult,
} from "../helpers/cli-result";

const CALL_TIMEOUT_MS = 30_000;
const HAS_API_KEY = Boolean(process.env.ELEVENLABS_API_KEY);

describe.skipIf(!HAS_API_KEY)("integration (live API, read-only)", () => {
  let cacheDir: string;
  const apiKey = process.env.ELEVENLABS_API_KEY ?? "";

  // Async spawn (NOT spawnSync): keep the event loop free for child I/O.
  function runElv(args: string[]): Promise<CliResult> {
    return runCli(args, {
      ELEVENLABS_API_KEY: apiKey,
      ELV_CACHE_DIR: cacheDir,
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

      const data = envelope.data;
      const results = Array.isArray(data) ? data : arrayValue(recordValue(data, "data").results);
      expect(arrayValue(results, "results").length).toBeGreaterThan(0);
    },
    CALL_TIMEOUT_MS,
  );
});
