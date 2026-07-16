import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHttpRequest } from "../../src/core/request-builder";
import { normalizeResponse } from "../../src/core/response-normalizer";
import type { OperationCard } from "../../src/openapi/types";

let out: string;

beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), "elv-json-events-"));
});

afterEach(() => {
  rmSync(out, { recursive: true, force: true });
});

function op(): OperationCard {
  return {
    operationId: "text_to_speech_stream_with_timestamps",
    method: "POST",
    pathTemplate: "/v1/text-to-speech/{voice_id}/stream/with-timestamps",
    group: [],
    tags: [],
    risk: "generate",
    pathParams: [],
    queryParams: [{ name: "output_format", location: "query", required: false, schema: {} }],
    headerParams: [],
    requestBody: { contentType: "application/json", required: true, multipart: false },
    responses: [{ status: "200", contentType: "application/json", binary: false }],
    returnsBinary: false,
    returnsJson: true,
    streamKind: "json_events",
    deprecated: false,
    examples: [],
  };
}

describe("json_events response parsing", () => {
  it("writes ndjson and decoded audio without piping raw JSON as audio", async () => {
    const one = Buffer.from("one");
    const two = Buffer.from("two");
    const event1 = JSON.stringify({
      audio_base64: one.toString("base64"),
      alignment: { chars: ["a"] },
    });
    const event2 = JSON.stringify({
      audio: two.toString("base64"),
      normalized_alignment: { chars: ["b"] },
    });
    const stream = Readable.from(
      [event1, "\n", event2.slice(0, 8), event2.slice(8)].map((chunk) => Buffer.from(chunk)),
    );

    const env = await normalizeResponse(
      op(),
      new Response(Readable.toWeb(stream) as ConstructorParameters<typeof Response>[0], {
        headers: { "content-type": "application/json" },
      }),
      {
        cmd: "elv call text_to_speech_stream_with_timestamps",
        out,
        requestPath: "/v1/text-to-speech/v1/stream/with-timestamps?output_format=mp3_44100_128",
      },
    );

    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error("expected success");
    expect(env.files).toHaveLength(2);
    const ndjson = env.files!.find((file) => file.path.endsWith(".ndjson"));
    const audio = env.files!.find((file) => file.path.endsWith(".mp3"));
    expect(ndjson).toBeDefined();
    expect(audio).toBeDefined();
    expect(existsSync(ndjson!.path)).toBe(true);
    expect(readFileSync(ndjson!.path, "utf8").trim().split("\n")).toHaveLength(2);
    expect(readFileSync(ndjson!.path, "utf8")).toContain("alignment");
    expect(readFileSync(audio!.path)).toEqual(Buffer.concat([one, two]));
    expect(readFileSync(audio!.path, "utf8")).not.toContain("audio_base64");
  });

  it("requires directory --out for json_events multi-file output", async () => {
    await expect(
      normalizeResponse(
        op(),
        new Response(JSON.stringify({ audio_base64: Buffer.from("x").toString("base64") }), {
          headers: { "content-type": "application/json" },
        }),
        { cmd: "elv call text_to_speech_stream_with_timestamps", out: join(out, "one.mp3") },
      ),
    ).rejects.toThrow(/--out file/u);
  });

  it("keeps braces inside strings after escaped quotes", async () => {
    const event = JSON.stringify({
      text: 'The model said "keep } inside the string"',
      audio_base64: Buffer.from("audio").toString("base64"),
    });
    const env = await normalizeResponse(
      op(),
      new Response(
        Readable.toWeb(Readable.from([event])) as ConstructorParameters<typeof Response>[0],
        {
          headers: { "content-type": "application/json" },
        },
      ),
      { cmd: "elv call text_to_speech_stream_with_timestamps", out },
    );

    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error("expected success");
    const ndjson = env.files?.find((file) => file.path.endsWith(".ndjson"));
    expect(ndjson).toBeDefined();
    expect(JSON.parse(readFileSync(ndjson!.path, "utf8"))).toMatchObject({
      text: 'The model said "keep } inside the string"',
    });
  });

  it("preserves valid paid output before an incomplete trailing JSON event", async () => {
    const audioBytes = Buffer.from("paid-output");
    const valid = JSON.stringify({
      audio_base64: audioBytes.toString("base64"),
      alignment: { chars: ["a"] },
    });
    const stream = Readable.from([Buffer.from(valid), Buffer.from('{"audio_base64":"')]);

    const env = await normalizeResponse(
      op(),
      new Response(Readable.toWeb(stream) as ConstructorParameters<typeof Response>[0], {
        headers: { "content-type": "application/json" },
      }),
      {
        cmd: "elv call text_to_speech_stream_with_timestamps",
        out,
        requestPath: "/v1/text-to-speech/v1/stream/with-timestamps?output_format=mp3_44100_128",
      },
    );

    expect(env.ok).toBe(false);
    if (env.ok) throw new Error("expected failure");
    expect(env.error).toMatchObject({
      type: "provider_error",
      code: "invalid_json_events_stream",
      message: "Provider returned a malformed JSON events stream",
    });
    expect(env.files).toHaveLength(2);
    expect(env.files?.every((file) => file.partial)).toBe(true);
    const ndjson = env.files?.find((file) => file.path.endsWith(".ndjson"));
    const audio = env.files?.find((file) => file.path.endsWith(".mp3"));
    expect(readFileSync(ndjson!.path, "utf8").trim()).toBe(valid);
    expect(readFileSync(audio!.path)).toEqual(audioBytes);
    expect(env.hints?.[0]?.why).toContain("credits may already have been consumed");
  });

  it("rejects invalid base64 without preserving corrupt output", async () => {
    const env = await normalizeResponse(
      op(),
      new Response(JSON.stringify({ audio_base64: "not!!valid" }), {
        headers: { "content-type": "application/json" },
      }),
      { cmd: "elv call text_to_speech_stream_with_timestamps", out },
    );

    expect(env.ok).toBe(false);
    if (env.ok) throw new Error("expected failure");
    expect(env.error.code).toBe("invalid_json_events_stream");
    expect(env.files).toBeUndefined();
    expect(JSON.stringify(env.error.raw)).toContain("Invalid base64 audio");
  });

  it("uses the final built request query to choose the audio extension", async () => {
    const operation = op();
    const request = await buildHttpRequest(
      operation,
      {
        path: { voice_id: "voice" },
        query: { output_format: "pcm_44100" },
        body: { text: "hello" },
      },
      { baseUrl: "https://api.test" },
    );
    const env = await normalizeResponse(
      operation,
      new Response(JSON.stringify({ audio_base64: Buffer.from("pcm").toString("base64") }), {
        headers: { "content-type": "application/json" },
      }),
      {
        cmd: "elv call text_to_speech_stream_with_timestamps",
        out,
        requestPath: request.path,
      },
    );

    expect(request.path).toBe(
      "/v1/text-to-speech/voice/stream/with-timestamps?output_format=pcm_44100",
    );
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error("expected success");
    expect(env.files?.some((file) => file.path.endsWith(".pcm"))).toBe(true);
  });
});
