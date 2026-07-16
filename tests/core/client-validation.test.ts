import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { envelopeForThrown, runOperation } from "../../src/core/client";
import { exitCodeForError } from "../../src/core/errors";
import { ExitCode } from "../../src/core/types";
import { SchemaResolutionError } from "../../src/openapi/types";

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
  it("reports local schema compilation failures as actionable non-transient errors", () => {
    const env = envelopeForThrown(
      "elv call broken_operation",
      "broken_operation",
      new SchemaResolutionError("broken_operation", new Error("missing #/components/schemas/X")),
    );

    expect(env.ok).toBe(false);
    if (env.ok) throw new Error("expected schema failure");
    expect(env.error).toMatchObject({
      type: "schema_resolution_error",
      code: "schema_resolution_error",
    });
    expect(env.retry?.recommended).toBe(false);
    expect(exitCodeForError(env.error)).toBe(ExitCode.ProviderError);
    expect(env.hints?.[0]?.cmd).toBe("elv ops schema broken_operation --example");
  });

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
