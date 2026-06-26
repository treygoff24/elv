import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InputNormalizationError, buildHttpRequest, normalizeInput } from "../src/core/request-builder";
import type { OperationCard } from "../src/core/types";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "elv-multipart-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function multipartOp(overrides: Partial<OperationCard> = {}): OperationCard {
  return {
    operationId: "audio_isolation",
    method: "POST",
    pathTemplate: "/v1/audio-isolation",
    group: [],
    tags: [],
    risk: "generate",
    pathParams: [],
    queryParams: [],
    headerParams: [],
    requestBody: {
      contentType: "multipart/form-data",
      required: true,
      multipart: true,
      schema: {
        type: "object",
        properties: { audio: { type: "string", format: "binary" }, model_id: { type: "string" } },
      },
      fileFields: ["audio"],
    },
    responses: [{ status: "200", contentType: "audio/mpeg", binary: true }],
    returnsBinary: true,
    returnsJson: false,
    streamKind: "none",
    deprecated: false,
    examples: [],
    ...overrides,
  };
}

function count(form: FormData, field: string): number {
  return form.getAll(field).length;
}

describe("multipart request builder (native FormData + openAsBlob)", () => {
  it("builds audio_isolation multipart with audio as a file-backed blob", async () => {
    const audio = join(dir, "noisy.mp3");
    writeFileSync(audio, "mp3");

    const req = await buildHttpRequest(
      multipartOp(),
      { body: { model_id: "scribe" }, files: { audio } },
      { baseUrl: "https://api.test", apiKey: "key" },
    );

    expect(req.body).toBeInstanceOf(FormData);
    expect(req.headers["xi-api-key"]).toBe("key");
    // Content-Type is NOT set here; fetch derives multipart/form-data + boundary from the FormData body.
    expect(req.headers["content-type"]).toBeUndefined();

    const form = req.body as FormData;
    expect(count(form, "audio")).toBe(1);
    expect(count(form, "model_id")).toBe(1);

    const audioEntry = form.get("audio");
    expect(audioEntry).toBeInstanceOf(Blob);
    expect((audioEntry as File).name).toBe(basename(audio));
  });

  it("builds speech_to_text multipart with file as the upload field", async () => {
    const file = join(dir, "speech.wav");
    writeFileSync(file, "wav");

    const req = await buildHttpRequest(
      multipartOp({
        operationId: "speech_to_text",
        pathTemplate: "/v1/speech-to-text",
        requestBody: {
          contentType: "multipart/form-data",
          required: true,
          multipart: true,
          fileFields: ["file"],
        },
        returnsBinary: false,
        returnsJson: true,
        responses: [{ status: "200", contentType: "application/json", binary: false }],
      }),
      { body: { model_id: "scribe_v2" }, files: { file } },
      { baseUrl: "https://api.test" },
    );

    const form = req.body as FormData;
    expect(count(form, "file")).toBe(1);
    expect(count(form, "model_id")).toBe(1);
  });

  it("normalizes repeatable samples[]=path file arrays and appends each value", async () => {
    const a = join(dir, "a.wav");
    const b = join(dir, "b.wav");
    writeFileSync(a, "a");
    writeFileSync(b, "b");
    const op = multipartOp({
      operationId: "voice_clone",
      requestBody: {
        contentType: "multipart/form-data",
        required: true,
        multipart: true,
        fileFields: ["samples"],
      },
    });

    const normalized = normalizeInput(op, { files: { "samples[]": [a, b] } });
    const req = await buildHttpRequest(op, normalized, { baseUrl: "https://api.test" });

    expect(normalized.files).toEqual({ samples: [a, b] });
    expect(count(req.body as FormData, "samples")).toBe(2);
  });

  it("builds clone-instant files as repeated multipart parts", async () => {
    const a = join(dir, "a.mp3");
    const b = join(dir, "b.mp3");
    writeFileSync(a, "a");
    writeFileSync(b, "b");
    const op = multipartOp({
      operationId: "add_voice",
      pathTemplate: "/v1/voices/add",
      requestBody: {
        contentType: "multipart/form-data",
        required: true,
        multipart: true,
        schema: {
          type: "object",
          properties: {
            name: { type: "string" },
            files: { type: "array", items: { type: "string", format: "binary" } },
          },
        },
        fileFields: ["files"],
      },
      returnsBinary: false,
      returnsJson: true,
      responses: [{ status: "200", contentType: "application/json", binary: false }],
    });

    const one = await buildHttpRequest(
      op,
      { body: { name: "Clone" }, files: { files: a } },
      { baseUrl: "https://api.test" },
    );
    const two = await buildHttpRequest(
      op,
      { body: { name: "Clone" }, files: { files: [a, b] } },
      { baseUrl: "https://api.test" },
    );

    expect(count(one.body as FormData, "files")).toBe(1);
    expect(count(two.body as FormData, "files")).toBe(2);
    expect(count(two.body as FormData, "name")).toBe(1);
  });

  it("rejects uploads above the configured hard cap before opening streams", async () => {
    const audio = join(dir, "huge.mp3");
    writeFileSync(audio, "abc");

    await expect(
      buildHttpRequest(
        multipartOp(),
        { files: { audio } },
        { baseUrl: "https://api.test", maxUploadBytes: statSync(audio).size - 1 },
      ),
    ).rejects.toThrow(InputNormalizationError);
  });
});
