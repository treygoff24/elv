import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeResponse } from "../src/core/response-normalizer";
import type { OperationCard } from "../src/core/types";

function op(overrides: Partial<OperationCard> = {}): OperationCard {
  return {
    operationId: "response_demo",
    method: "GET",
    pathTemplate: "/v1/demo",
    group: [],
    tags: [],
    risk: "read",
    pathParams: [],
    queryParams: [],
    headerParams: [],
    responses: [],
    returnsBinary: false,
    returnsJson: true,
    streamKind: "none",
    deprecated: false,
    examples: [],
    ...overrides,
  };
}

describe("response normalization", () => {
  it("streams binary to files and never puts bytes in data", async () => {
    const out = mkdtempSync(join(tmpdir(), "elv-out-"));
    const env = await normalizeResponse(
      op({ returnsBinary: true, responses: [{ status: "200", contentType: "audio/mpeg", binary: true }], streamKind: "audio_bytes" }),
      new Response(Buffer.from("mp3-bytes"), { status: 200, headers: { "content-type": "audio/mpeg" } }),
      { cmd: "elv call response_demo", out },
    );

    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error("expected success");
    expect(env.data).toBeUndefined();
    expect(env.files).toHaveLength(1);
    expect(readFileSync(env.files![0]!.path, "utf8")).toBe("mp3-bytes");
  });

  it("inlines small JSON and tolerates unknown response fields", async () => {
    const env = await normalizeResponse(
      op(),
      new Response(JSON.stringify({ known: true, provider_added: "ignored by schema" }), {
        status: 200,
        headers: { "content-type": "application/json", "request-id": "req_1", "character-cost": "12" },
      }),
      { cmd: "elv call response_demo" },
    );

    expect(env).toMatchObject({
      ok: true,
      request: { id: "req_1" },
      cost: { credits_charged: 12, credits_source: "header" },
      data: { known: true, provider_added: "ignored by schema" },
    });
  });

  it.each([Buffer.from("mp3"), Buffer.alloc(40 * 1024, 7)])(
    "decodes single-body timestamp audio and writes alignment sidecar",
    async (audio) => {
      const out = mkdtempSync(join(tmpdir(), "elv-timestamps-"));
      const env = await normalizeResponse(
        op({
          operationId: "text_to_speech_full_with_timestamps",
          method: "POST",
          pathTemplate: "/v1/text-to-speech/{voice_id}/with-timestamps",
          risk: "generate",
          costHint: "characters",
        }),
        new Response(
          JSON.stringify({
            audio_base64: audio.toString("base64"),
            alignment: { chars: ["a"] },
            normalized_alignment: { chars: ["A"] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
        {
          cmd: "elv call text_to_speech_full_with_timestamps",
          out,
          requestPath: "/v1/text-to-speech/v1/with-timestamps?output_format=mp3_44100_128",
          creditsEstimated: 1,
        },
      );

      expect(env.ok).toBe(true);
      if (!env.ok) throw new Error("expected success");
      expect(JSON.stringify(env)).not.toContain("audio_base64");
      expect(env.data).toBeUndefined();
      expect(env.files).toHaveLength(2);
      const audioFile = env.files!.find((file) => file.path.endsWith(".mp3"));
      const sidecar = env.files!.find((file) => file.path.endsWith(".timestamps.json"));
      expect(audioFile).toBeDefined();
      expect(sidecar).toBeDefined();
      expect(readFileSync(audioFile!.path)).toEqual(audio);
      expect(JSON.parse(readFileSync(sidecar!.path, "utf8"))).toEqual({
        alignment: { chars: ["a"] },
        normalized_alignment: { chars: ["A"] },
      });
    },
  );

  it("writes timestamp audio with extension inside a non-existent extensionless out dir", async () => {
    const audio = Buffer.from("mp3");
    const parent = mkdtempSync(join(tmpdir(), "elv-timestamps-parent-"));
    const out = join(parent, "out");
    const env = await normalizeResponse(
      op({
        operationId: "text_to_speech_full_with_timestamps",
        method: "POST",
        pathTemplate: "/v1/text-to-speech/{voice_id}/with-timestamps",
        risk: "generate",
        costHint: "characters",
      }),
      new Response(
        JSON.stringify({
          audio_base64: audio.toString("base64"),
          alignment: { chars: ["a"] },
          normalized_alignment: { chars: ["A"] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      {
        cmd: "elv call text_to_speech_full_with_timestamps",
        out,
        requestPath: "/v1/text-to-speech/v1/with-timestamps?output_format=mp3_44100_128",
        creditsEstimated: 1,
      },
    );

    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error("expected success");
    expect(env.files).toHaveLength(2);
    const audioFile = env.files!.find((file) => file.path.endsWith(".mp3"));
    const sidecar = env.files!.find((file) => file.path.endsWith(".timestamps.json"));
    expect(audioFile).toBeDefined();
    expect(sidecar).toBeDefined();
    expect(dirname(audioFile!.path)).toBe(out);
    expect(dirname(sidecar!.path)).toBe(out);
    expect(readFileSync(audioFile!.path)).toEqual(audio);
  });

  it("does not warn about absent cost headers on reads", async () => {
    const env = await normalizeResponse(
      op({ costHint: "unknown" }),
      new Response(JSON.stringify({ voices: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      { cmd: "elv call get_voices" },
    );

    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error("expected success");
    expect(env.warnings?.some((warning) => warning.code === "cost_header_absent")).not.toBe(true);
  });

  it("warns about absent cost headers when credits were estimated", async () => {
    const env = await normalizeResponse(
      op({ operationId: "text_to_speech_full", method: "POST", risk: "generate", costHint: "characters" }),
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      { cmd: "elv call text_to_speech_full", creditsEstimated: 4 },
    );

    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error("expected success");
    expect(env.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "cost_header_absent" }),
      ]),
    );
  });

  it("adds actionable hints for provider auth errors", async () => {
    const env = await normalizeResponse(
      op(),
      new Response(JSON.stringify({ detail: { status: "invalid_api_key", message: "Invalid API key" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
      { cmd: "elv call response_demo" },
    );

    expect(env.ok).toBe(false);
    if (env.ok) throw new Error("expected failure");
    expect(env.hints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cmd: "elv config doctor", why: expect.stringContaining("ELEVENLABS_API_KEY") }),
      ]),
    );
  });

  it("points spilled JSON hints at elv view", async () => {
    const out = mkdtempSync(join(tmpdir(), "elv-spill-hint-"));
    const items = Array.from({ length: 30 }, (_, index) => ({ index, value: "x".repeat(1200) }));
    const body = JSON.stringify(items);
    expect(Buffer.byteLength(body)).toBeGreaterThanOrEqual(32 * 1024);

    const env = await normalizeResponse(
      op(),
      new Response(body, { headers: { "content-type": "application/json" } }),
      { cmd: "elv call big_json", out },
    );

    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error("expected success");
    expect(env.hints?.[0]?.cmd).toMatch(/^elv view /);
    expect(env.hints?.[0]?.why).toContain("without loading it into context");
  });
});
