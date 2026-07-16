import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runHttp } from "../../src/commands/http";
import { runOperation } from "../../src/core/client";
import type { OperationCard } from "../../src/openapi/types";

const registry = vi.hoisted(() => new Map<string, OperationCard>());

vi.mock("../../src/openapi/registry", () => ({
  loadRegistry: async () => registry,
  readRegistryCache: () => undefined,
}));

function op(overrides: Partial<OperationCard> & Pick<OperationCard, "operationId">): OperationCard {
  const { operationId, ...rest } = overrides;
  return {
    operationId,
    method: "GET",
    pathTemplate: "/v1/test",
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
    costHint: "unknown",
    deprecated: false,
    examples: [],
    ...rest,
  };
}

const tts = () =>
  op({
    operationId: "text_to_speech_full",
    method: "POST",
    pathTemplate: "/v1/text-to-speech/{voice_id}",
    risk: "generate",
    costHint: "characters",
    pathParams: [
      {
        name: "voice_id",
        location: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    requestBody: {
      contentType: "application/json",
      required: true,
      multipart: false,
    },
    returnsBinary: true,
    returnsJson: false,
    streamKind: "audio_bytes",
  });

describe("raw HTTP registry metadata and budget policy", () => {
  beforeEach(() => {
    registry.clear();
    vi.stubEnv("ELV_CONFIG", undefined);
    vi.stubEnv("ELV_MAX_CREDITS", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("chooses the most literal path before a parameter template", async () => {
    registry.set(
      "parameter",
      op({
        operationId: "parameter",
        pathTemplate: "/v1/dubbing/{dubbing_id}",
      }),
    );
    registry.set("literal", op({ operationId: "literal", pathTemplate: "/v1/dubbing/project" }));

    const env = await runHttp("GET", "/v1/dubbing/project", { dryRun: true });

    expect(env).toMatchObject({
      ok: true,
      operation_id: "literal",
      warnings: [{ code: "http_metadata_matched" }],
    });
  });

  it("identifies fallback metadata when no registry path matches", async () => {
    const env = await runHttp("GET", "/v1/private/new-surface", { dryRun: true });

    expect(env).toMatchObject({
      ok: true,
      operation_id: "http",
      warnings: [{ code: "http_metadata_inferred" }],
    });
  });

  it("rejects equally specific matches with conflicting safety metadata", async () => {
    registry.set(
      "read_widget",
      op({
        operationId: "read_widget",
        method: "POST",
        pathTemplate: "/v1/widgets/{id}",
      }),
    );
    registry.set(
      "delete_widget",
      op({
        operationId: "delete_widget",
        method: "POST",
        pathTemplate: "/v1/widgets/{name}",
        risk: "destructive",
      }),
    );

    const env = await runHttp("POST", "/v1/widgets/one", { bodyJson: "{}" });

    expect(env).toMatchObject({
      ok: false,
      operation_id: "http",
      error: {
        code: "validation_error",
        message: "Ambiguous HTTP metadata for POST /v1/widgets/one",
      },
    });
  });

  it("inherits TTS operation identity and character budget blocking", async () => {
    registry.set("text_to_speech_full", tts());
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const env = await runHttp("POST", "/v1/text-to-speech/voice_1", {
      bodyJson: '{"text":"hello"}',
      maxCredits: 4,
      baseUrl: "https://api.test",
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(env).toMatchObject({
      ok: false,
      operation_id: "text_to_speech_full",
      error: { code: "budget" },
      cost: { credits_estimated: 5 },
      warnings: [{ code: "http_metadata_matched" }],
    });
  });

  it("inherits Music generation metadata instead of the synthetic HTTP card", async () => {
    registry.set(
      "compose_detailed_stream",
      op({
        operationId: "compose_detailed_stream",
        method: "POST",
        pathTemplate: "/v1/music/detailed/stream",
        risk: "generate",
        costHint: "per_generation",
        streamKind: "text",
      }),
    );

    const env = await runHttp("POST", "/v1/music/detailed/stream", {
      bodyJson: '{"prompt":"piano"}',
      maxCredits: 4_000,
    });

    expect(env).toMatchObject({
      ok: false,
      operation_id: "compose_detailed_stream",
      error: { code: "budget" },
      cost: { credits_estimated: 4_500 },
      warnings: expect.arrayContaining([
        expect.objectContaining({ code: "http_metadata_matched" }),
      ]),
    });
  });

  it("fails closed when a generation estimate is unavailable", async () => {
    registry.set(
      "text_to_voice",
      op({
        operationId: "text_to_voice",
        method: "POST",
        pathTemplate: "/v1/text-to-voice",
        risk: "generate",
        costHint: "slot",
      }),
    );
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const env = await runHttp("POST", "/v1/text-to-voice", {
      bodyJson: '{"text":"hello"}',
      maxCredits: 10,
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(env).toMatchObject({
      ok: false,
      operation_id: "text_to_voice",
      error: { code: "budget_estimate_unavailable" },
      cost: { credits_estimated: null },
    });
  });

  it("reports an honest unbounded policy for non-generation operations", async () => {
    registry.set("get_test", op({ operationId: "get_test" }));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response('{"ok":true}', {
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const dryRunEnv = await runHttp("GET", "/v1/test", {
      dryRun: true,
      maxCredits: 1,
    });
    expect(dryRunEnv).toMatchObject({
      ok: true,
      data: { budget_policy: "unknown_unbounded", would_exceed_budget: null },
    });

    const liveEnv = await runHttp("GET", "/v1/test", {
      maxCredits: 1,
      baseUrl: "https://api.test",
    });
    expect(liveEnv).toMatchObject({
      ok: true,
      warnings: expect.arrayContaining([
        expect.objectContaining({ code: "budget_policy_unknown_unbounded" }),
      ]),
    });
  });

  it("applies explicit, environment, then profile ceilings to call runner preflight", async () => {
    registry.set("text_to_speech_full", tts());
    vi.stubEnv("ELV_CONFIG", resolve("tests/core/fixtures/budget-profile.json"));
    vi.stubEnv("ELV_MAX_CREDITS", "3");
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response("audio", { headers: { "content-type": "audio/mpeg" } }));
    vi.stubGlobal("fetch", fetch);
    const input = { path: { voice_id: "voice_1" }, body: { text: "four" } };

    const explicit = await runOperation("text_to_speech_full", input, {
      maxCredits: 4,
      baseUrl: "https://api.test",
    });
    expect(explicit.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);

    const fromEnv = await runOperation("text_to_speech_full", input, {
      baseUrl: "https://api.test",
    });
    expect(fromEnv).toMatchObject({ ok: false, error: { code: "budget" } });

    vi.stubEnv("ELV_MAX_CREDITS", undefined);
    const fromProfile = await runOperation("text_to_speech_full", input, {
      baseUrl: "https://api.test",
    });
    expect(fromProfile).toMatchObject({ ok: false, error: { code: "budget" } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
