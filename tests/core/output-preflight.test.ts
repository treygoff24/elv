import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runOperation } from "../../src/core/client";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("multi-file output preflight", () => {
  it.each(["compose_detailed", "compose_detailed_stream"])(
    "validates output shape before spending or returning a dry-run for %s",
    async (operationId) => {
      const dir = mkdtempSync(join(tmpdir(), "elv-output-preflight-"));
      vi.stubEnv("ELV_CACHE_DIR", join(dir, "cache"));
      vi.stubEnv("ELV_MAX_CREDITS", undefined);
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      try {
        for (const dryRun of [true, false]) {
          const result = await runOperation(
            operationId,
            { body: { prompt: "Quiet instrumental" } },
            { dryRun, out: join(dir, "audio.mp3") },
          );
          expect(result.ok).toBe(false);
          if (result.ok) throw new Error("Expected invalid output target");
          expect(result.error.message).toContain("--out file");
          expect(fetch).not.toHaveBeenCalled();
        }
        const valid = await runOperation(
          operationId,
          { body: { prompt: "Quiet instrumental" } },
          { dryRun: true, out: join(dir, "output") },
        );
        expect(valid.ok).toBe(true);
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
