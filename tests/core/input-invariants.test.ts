import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runHttp } from "../../src/commands/http";
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

  it("ignores null URL placeholders when an uploaded file supplies the source", async () => {
    const result = await runOperation(
      "speech_to_text",
      {
        body: { model_id: "scribe_v2", source_url: null, cloud_storage_url: null },
        files: { file: "/tmp/audio.mp3" },
      },
      { dryRun: true, apiKey: "test_key_CANARY" },
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each<[string, AgentInput]>([
    ["null URL", { body: { model_id: "scribe_v2", source_url: null } }],
    ["blank URL", { body: { model_id: "scribe_v2", source_url: "" } }],
    ["blank file path", { body: { model_id: "scribe_v2" }, files: { file: "" } }],
    ["empty file list", { body: { model_id: "scribe_v2" }, files: { file: [] } }],
  ])("treats an empty STT source as absent: %s", async (_name, input) => {
    expectValidationFailure(
      await runOperation("speech_to_text", input, {
        dryRun: true,
        apiKey: "test_key_CANARY",
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves matched raw HTTP requests forward-compatible with new media fields", async () => {
    const result = await runHttp("POST", "/v1/speech-to-text", {
      bodyJson: JSON.stringify({ model_id: "scribe_v2", media_url: "https://example.test/a.mp3" }),
      dryRun: true,
      apiKey: "test_key_CANARY",
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("turns a silently ignored body.file near miss into an exact --file replay", async () => {
    const result = expectValidationFailure(
      await runOperation(
        "speech_to_text",
        { body: { model_id: "scribe_v2", file: "/tmp/body-audio.mp3" } },
        { dryRun: true, apiKey: "test_key_CANARY" },
      ),
    );

    expect(result.error.message).toContain("body.file");
    expect(result.error.message).toContain("--file file=PATH");
    expect(result.hints?.[0]?.cmd).toBe(
      `elv call speech_to_text --json '{"body":{"model_id":"scribe_v2"}}' --file 'file=/tmp/body-audio.mp3' --dry-run`,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
