import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runOperation } from "../../src/core/client";

let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "elv-validation-cache-"));
  vi.stubEnv("ELV_CACHE_DIR", cacheDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("runner request validation", () => {
  it("accepts scalar and array values for array-typed multipart file fields", async () => {
    for (const files of ["sample.mp3", ["sample.mp3"]]) {
      const env = await runOperation(
        "add_voice",
        { body: { name: "Clone" }, files: { files } },
        { dryRun: true },
      );

      expect(env.ok).toBe(true);
    }
  });

  it("points stale model enum failures to the spec refresh workflow", async () => {
    const env = await runOperation(
      "generate",
      {
        body: { prompt: "Hello", model_id: "music_just_launched" },
      },
      { dryRun: true },
    );

    expect(env.ok).toBe(false);
    if (env.ok) throw new Error("expected validation failure");
    expect(env.error.param).toBe("model_id");
    expect(env.hints?.map((hint) => hint.cmd)).toEqual([
      "elv spec status",
      "elv spec diff",
      "elv spec update",
    ]);
  });
});
