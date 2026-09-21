import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runOperation } from "../../src/core/client";
import { exitCodeForError } from "../../src/core/errors";
import { ExitCode, type AgentInput, type ErrorEnvelope } from "../../src/core/types";

function expectValidationFailure(result: Awaited<ReturnType<typeof runOperation>>): ErrorEnvelope {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected validation failure");
  expect(result.error).toMatchObject({
    code: "validation_error",
    param: "media_source",
  });
  expect(exitCodeForError(result.error)).toBe(ExitCode.InputValidation);
  return result;
}

describe("operation-specific input invariants", () => {
  const fetch = vi.fn();

  beforeEach(() => {
    fetch.mockReset();
    vi.stubGlobal("fetch", fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([true, false])(
    "rejects source-less speech_to_text input before network (dryRun=%s)",
    async (dryRun) => {
      const result = expectValidationFailure(
        await runOperation(
          "speech_to_text",
          { body: { model_id: "scribe_v2" } },
          { dryRun, apiKey: "test_key_CANARY" },
        ),
      );

      expect(result.error.message).toContain("exactly one media source");
      expect(result.hints).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ cmd: expect.stringContaining("--file file=./path/to/file") }),
          expect.objectContaining({ cmd: expect.stringContaining('"source_url"') }),
        ]),
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects multiple STT media sources before network", async () => {
    const result = expectValidationFailure(
      await runOperation(
        "speech_to_text",
        {
          body: { model_id: "scribe_v2", source_url: "https://example.test/audio.mp3" },
          files: { file: "/tmp/audio.mp3" },
        },
        { apiKey: "test_key_CANARY" },
      ),
    );

    expect(result.error.raw).toEqual({
      expected: 1,
      present: ["files.file", "body.source_url"],
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each<[string, AgentInput]>([
    ["uploaded file", { body: { model_id: "scribe_v2" }, files: { file: "/tmp/audio.mp3" } }],
    [
      "source URL",
      { body: { model_id: "scribe_v2", source_url: "https://example.test/audio.mp3" } },
    ],
    [
      "legacy cloud URL",
      {
        body: {
          model_id: "scribe_v2",
          cloud_storage_url: "https://example.test/legacy-audio.mp3",
        },
      },
    ],
  ])("accepts exactly one STT media source: %s", async (_name, input) => {
    const result = await runOperation("speech_to_text", input, {
      dryRun: true,
      apiKey: "test_key_CANARY",
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});
