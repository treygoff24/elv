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

  it("rejects multipart binary fields supplied in the body bucket before dry-run", async () => {
    const env = await runOperation(
      "upload_asset",
      { body: { asset: "/tmp/file.mp4", name: "clip" } },
      { dryRun: true },
    );

    expect(env.ok).toBe(false);
    if (env.ok) throw new Error("expected validation failure");
    expect(env.error.message).toContain("--file asset=PATH");
    expect(env.error.param).toBe("asset");
  });

  it("does not reject null multipart binary body fields with the body-bucket guard", async () => {
    const env = await runOperation(
      "upload_asset",
      { body: { asset: null, name: "clip" } },
      { dryRun: true },
    );

    expect(env.ok).toBe(false);
    if (env.ok) throw new Error("expected schema validation failure");
    expect(env.error.message).toContain("must be string");
    expect(env.error.message).not.toContain("--file asset=PATH");
  });

  it("fails closed for unpriced Flows image/video generation under a credit ceiling", async () => {
    for (const [operationId, body] of [
      ["create_image_generation", { prompt: "cat", model_id: "gpt-image-1" }],
      [
        "create_video_generation",
        {
          model_id: "creatify-aurora",
          image: { type: "generation", generation_id: "img_1" },
          audio: { type: "generation", generation_id: "aud_1" },
        },
      ],
    ] as const) {
      for (const yes of [false, true]) {
        const env = await runOperation(operationId, { body }, { maxCredits: 1, yes });

        expect(env.ok, `${operationId} yes=${yes}`).toBe(false);
        if (env.ok) throw new Error("expected budget failure");
        expect(env.error.code, `${operationId} yes=${yes}`).toBe("budget_estimate_unavailable");
        expect(env.cost?.credits_estimated, `${operationId} yes=${yes}`).toBeNull();
      }
    }
  });

  it("bounds asynchronous Flows text-to-speech generation by characters", async () => {
    const env = await runOperation(
      "create_text_to_speech_generation",
      { body: { text: "hello", voice: "voice_1", model_id: "eleven_flash_v2_5" } },
      { maxCredits: 2 },
    );

    expect(env.ok).toBe(false);
    if (env.ok) throw new Error("expected budget failure");
    expect(env.error.code).toBe("budget");
    expect(env.cost?.credits_estimated).toBe(2.5);
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
