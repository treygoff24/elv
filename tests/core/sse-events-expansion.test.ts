import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { normalizeResponse } from "../../src/core/response-normalizer";
import { compileSpec } from "../../src/openapi/compile-spec";
import type { OperationCard } from "../../src/openapi/types";

function sseOp(): OperationCard {
  return {
    operationId: "compose_detailed_stream",
    method: "POST",
    pathTemplate: "/v1/music/detailed/stream",
    group: ["music"],
    tags: ["music-generation"],
    risk: "generate",
    pathParams: [],
    queryParams: [],
    headerParams: [],
    requestBody: {
      contentType: "application/json",
      required: true,
      multipart: false,
    },
    responses: [{ status: "200", contentType: "text/event-stream", binary: false }],
    returnsBinary: false,
    returnsJson: false,
    streamKind: "sse_events",
    costHint: "per_generation",
    deprecated: false,
    examples: [],
  };
}

function responseFromCharacters(body: string): Response {
  const stream = Readable.from([...Buffer.from(body)].map((byte) => Buffer.from([byte])));
  return new Response(Readable.toWeb(stream) as ConstructorParameters<typeof Response>[0], {
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

describe("SSE response normalization", () => {
  it("compiles event-stream operations as SSE generation metadata", async () => {
    const compiled = await compileSpec({
      sourcePath: "spec/openapi.snapshot.json",
    });
    expect(
      compiled.operations.find((op) => op.operationId === "compose_detailed_stream"),
    ).toMatchObject({
      streamKind: "sse_events",
      risk: "generate",
      costHint: "per_generation",
    });
  });

  it("parses split SSE framing, preserves metadata, and decodes every documented audio key", async () => {
    const out = mkdtempSync(join(tmpdir(), "elv-sse-"));
    const one = Buffer.from("one");
    const two = Buffer.from("two");
    const three = Buffer.from("three");
    const four = Buffer.from("four");
    const body = [
      ": keepalive\r\n",
      "event: audio\r\n",
      "id: evt-1\r\n",
      "retry: 2500\r\n",
      `data: {"audio_chunk":"${one.toString("base64")}",\r\n`,
      'data: "marker":1}\r\n',
      "\r\n",
      "data: provider note\n\n",
      "data: {not-json}\n\n",
      `event: audio_chunk\ndata: ${four.toString("base64")}\n\n`,
      `data: {"audio_base64":"${two.toString("base64")}","timestamp":2}\r\r`,
      `data: {"audio":"${three.toString("base64")}","timestamp":3}\n\n`,
      "data: [DONE]\n\n",
    ].join("");

    const env = await normalizeResponse(sseOp(), responseFromCharacters(body), {
      cmd: "elv call compose_detailed_stream",
      out,
    });

    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error("expected success");
    const ndjson = env.files?.find((file) => file.path.endsWith(".ndjson"));
    const audio = env.files?.find((file) => file.path.endsWith(".mp3"));
    expect(ndjson).toBeDefined();
    expect(audio).toBeDefined();
    expect(existsSync(ndjson!.path)).toBe(true);
    expect(readFileSync(audio!.path)).toEqual(Buffer.concat([one, four, two, three]));

    const events = readFileSync(ndjson!.path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toEqual([
      { event: "audio", id: "evt-1", retry: 2500, data: { marker: 1 } },
      { data: "provider note" },
      { data: "{not-json}" },
      { event: "audio_chunk", data: null },
      { data: { timestamp: 2 } },
      { data: { timestamp: 3 } },
    ]);
    expect(readFileSync(ndjson!.path, "utf8")).not.toMatch(
      /"(?:audio_chunk|audio_base64|audio)"\s*:/u,
    );
    expect(JSON.stringify(env)).not.toContain(one.toString("base64"));
  });

  it("returns a structured error while preserving valid paid output before a malformed tail", async () => {
    const out = mkdtempSync(join(tmpdir(), "elv-sse-partial-"));
    const audioBytes = Buffer.from("paid-output");
    const body =
      `data: {"audio_chunk":"${audioBytes.toString("base64")}","timestamp":1}\n\n` +
      'data: {"audio_chunk":"%%%"}\n\n';

    const env = await normalizeResponse(sseOp(), responseFromCharacters(body), {
      cmd: "elv call compose_detailed_stream",
      out,
    });

    expect(env.ok).toBe(false);
    if (env.ok) throw new Error("expected failure");
    expect(env.error).toMatchObject({
      type: "provider_error",
      code: "invalid_sse_stream",
      message: "Provider returned a malformed SSE stream",
    });
    expect(env.files).toHaveLength(2);
    expect(env.files?.every((file) => file.partial)).toBe(true);
    const audio = env.files?.find((file) => file.path.endsWith(".mp3"));
    const ndjson = env.files?.find((file) => file.path.endsWith(".ndjson"));
    expect(readFileSync(audio!.path)).toEqual(audioBytes);
    expect(readFileSync(ndjson!.path, "utf8").trim()).toBe('{"data":{"timestamp":1}}');
    expect(env.hints?.[0]?.why).toContain("credits may already have been consumed");
    expect(JSON.stringify(env)).not.toContain(audioBytes.toString("base64"));
  });

  it("decodes base64 split across SSE data lines without accepting other whitespace", async () => {
    const out = mkdtempSync(join(tmpdir(), "elv-sse-multiline-"));
    const audioBytes = Buffer.from("multiline-audio");
    const encoded = audioBytes.toString("base64");
    const split = Math.floor(encoded.length / 2);
    const valid = `event: audio_chunk\ndata: ${encoded.slice(0, split)}\ndata: ${encoded.slice(split)}\n\n`;

    const env = await normalizeResponse(sseOp(), responseFromCharacters(valid), {
      cmd: "elv call compose_detailed_stream",
      out,
    });

    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error("expected success");
    const audio = env.files?.find((file) => file.path.endsWith(".mp3"));
    expect(readFileSync(audio!.path)).toEqual(audioBytes);

    const invalid = await normalizeResponse(
      sseOp(),
      responseFromCharacters(
        `event: audio_chunk\ndata: ${encoded.slice(0, split)} ${encoded.slice(split)}\n\n`,
      ),
      {
        cmd: "elv call compose_detailed_stream",
        out: mkdtempSync(join(tmpdir(), "elv-sse-space-")),
      },
    );
    expect(invalid).toMatchObject({
      ok: false,
      error: {
        code: "invalid_sse_stream",
        raw: { parse_error: expect.stringContaining("Invalid base64") },
      },
    });
  });

  it("reports body interruption as a network failure while preserving paid output", async () => {
    const out = mkdtempSync(join(tmpdir(), "elv-sse-interrupted-"));
    const body = Readable.from(
      (async function* () {
        yield Buffer.from('data: {"status":"started"}\n\n');
        throw new Error("socket reset");
      })(),
    );
    const response = new Response(
      Readable.toWeb(body) as ConstructorParameters<typeof Response>[0],
      { headers: { "content-type": "text/event-stream" } },
    );

    const env = await normalizeResponse(sseOp(), response, {
      cmd: "elv call compose_detailed_stream",
      out,
    });

    expect(env).toMatchObject({
      ok: false,
      error: { type: "network_error", code: "stream_interrupted" },
      retry: { recommended: false },
      files: [{ partial: true }],
    });
    expect(env.hints?.[0]?.why).toContain("credits may already have been consumed");
  });
});
