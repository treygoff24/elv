import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("rejects incomplete trailing JSON events", async () => {
    const stream = Readable.from([Buffer.from('{"audio_base64":"')]);

    await expect(
      normalizeResponse(
        op(),
        new Response(Readable.toWeb(stream) as ConstructorParameters<typeof Response>[0], {
          headers: { "content-type": "application/json" },
        }),
        {
          cmd: "elv call text_to_speech_stream_with_timestamps",
          out,
          requestPath: "/v1/text-to-speech/v1/stream/with-timestamps?output_format=mp3_44100_128",
        },
      ),
    ).rejects.toThrow(/Incomplete trailing JSON event/u);
  });
});
