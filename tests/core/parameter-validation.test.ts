import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runHttp } from "../../src/commands/http";
import { runOperation, validateParameters } from "../../src/core/client";
import { exitCodeForError } from "../../src/core/errors";
import { ExitCode, type AgentInput, type Envelope } from "../../src/core/types";
import type { OperationCard } from "../../src/openapi/types";
import type { JsonValue } from "../../src/util/json";
import type { OpenApiDocument } from "../../src/openapi/compile-spec";
import * as registry from "../../src/openapi/registry";

function parameterOperation(
  schema: JsonValue,
  location: "query" | "header" = "query",
): OperationCard {
  const param = { name: "selector", location, required: true, schema };
  return {
    operationId: "parameter_test",
    method: "GET",
    pathTemplate: "/test",
    group: [],
    tags: [],
    pathParams: [],
    queryParams: location === "query" ? [param] : [],
    headerParams: location === "header" ? [param] : [],
    responses: [],
    risk: "read",
    returnsBinary: false,
    returnsJson: true,
    streamKind: "none",
    deprecated: false,
    examples: [],
  };
}

let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "elv-param-validation-"));
  vi.stubEnv("ELV_CACHE_DIR", cacheDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(cacheDir, { recursive: true, force: true });
});

function validationOf(env: Envelope) {
  expect(env.ok).toBe(false);
  if (env.ok) throw new Error("expected validation failure");
  return env;
}

describe("central parameter validation", () => {
  it.each(["anyOf", "oneOf"])("preserves an already-valid string branch in %s", async (keyword) => {
    const op = parameterOperation({
      [keyword]: [
        { type: "string", enum: ["1"] },
        { type: "integer", minimum: 2 },
      ],
    });
    const input: AgentInput = { query: { selector: "1" } };
    expect(await validateParameters(op, input, undefined)).toBeNull();
    expect(input.query).toEqual({ selector: "1" });
  });

  it.each(["anyOf", "oneOf"])(
    "coerces referenced numeric array items without changing a valid %s branch",
    async (keyword) => {
      const op = parameterOperation({
        type: "array",
        items: { $ref: "#/components/schemas/Selector" },
      });
      const spec: OpenApiDocument = {
        paths: {},
        components: {
          schemas: {
            Selector: {
              [keyword]: [
                { type: "string", enum: ["1"] },
                { type: "integer", minimum: 2 },
              ],
            },
          },
        },
      };
      const input: AgentInput = { query: { selector: ["1", "3"] } };
      expect(await validateParameters(op, input, spec)).toBeNull();
      expect(input.query).toEqual({ selector: ["1", 3] });
    },
  );

  it("keeps the original array unchanged when coerced validation fails", async () => {
    const input: AgentInput = { query: { selector: ["2", "invalid"] } };
    const op = parameterOperation({ type: "array", items: { type: "integer", minimum: 2 } });
    expect(await validateParameters(op, input, undefined)).toMatchObject({
      code: "validation_error",
    });
    expect(input.query).toEqual({ selector: ["2", "invalid"] });
  });

  it("does not merge inherited object properties into raw HTTP query values", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: string | URL | Request) => {
        urls.push(request instanceof Request ? request.url : String(request));
        return new Response("{}", { headers: { "content-type": "application/json" } });
      }),
    );
    expect(
      await runHttp("GET", "/v1/private/new-surface", {
        query: ["toString=literal"],
        apiKey: "test_key_CANARY",
      }),
    ).toMatchObject({ ok: true });
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]!).searchParams.getAll("toString")).toEqual(["literal"]);
  });

  it.each(["true", "false"])("accepts boolean query text %s", async (value) => {
    const input: AgentInput = { query: { selector: value } };
    expect(
      await validateParameters(parameterOperation({ type: "boolean" }), input, undefined),
    ).toBeNull();
    expect(input.query).toEqual({ selector: value === "true" });
  });

  it("validates required header schemas case-insensitively without rewriting header text", async () => {
    const input: AgentInput = { headers: { SELECTOR: "3" } };
    expect(
      await validateParameters(
        parameterOperation({ type: "integer", minimum: 2 }, "header"),
        input,
        undefined,
      ),
    ).toBeNull();
    expect(input.headers).toEqual({ SELECTOR: "3" });
  });

  it("does not coerce body values when parameter coercion is enabled", async () => {
    const env = await runOperation(
      "text_to_speech_full",
      {
        path: { voice_id: "voice_1" },
        query: { optimize_streaming_latency: "1" },
        body: { text: 123 },
      },
      { dryRun: true },
    );
    expect(validationOf(env).error.param).toBe("text");
  });

  it("rejects URL/flag scalar collisions without sending either ambiguous value", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response("{}", { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const env = await runHttp(
      "GET",
      "/v1/convai/conversations/conversation_1/summary?max_messages=201",
      {
        query: ["max_messages=10"],
        apiKey: "test_key_CANARY",
      },
    );
    const failure = validationOf(env);
    expect(failure.error.param).toBe("max_messages");
    expect(failure.error.message).toContain("only once");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("validates pagination-generated page size before known HTTP execution", async () => {
    const op = parameterOperation({ type: "integer", minimum: 2 });
    op.queryParams[0]!.name = "page_size";
    vi.spyOn(registry, "loadRegistry").mockResolvedValue(new Map([[op.operationId, op]]));
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response("{}", { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const env = await runHttp("GET", "/test", {
      limit: "1",
      apiKey: "test_key_CANARY",
    });
    expect(validationOf(env).error.param).toBe("page_size");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { path: "/v1/convai/agents/agent_1/triage-tickets?sources=qa", flags: [], values: ["qa"] },
    {
      path: "/v1/convai/agents/agent_1/triage-tickets?sources=qa",
      flags: ["sources[]=manual"],
      values: ["qa", "manual"],
    },
    {
      path: "/v1/private/new-surface?sources=qa&sources=agent",
      flags: ["sources=manual"],
      values: ["qa", "agent", "manual"],
    },
  ])(
    "preserves every URL/flag query value exactly once: $path",
    async ({ path, flags, values }) => {
      const urls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (request: string | URL | Request) => {
          urls.push(request instanceof Request ? request.url : String(request));
          return new Response("{}", { headers: { "content-type": "application/json" } });
        }),
      );
      const env = await runHttp("GET", path, { query: flags, apiKey: "test_key_CANARY" });
      expect(env, JSON.stringify(env)).toMatchObject({ ok: true });
      expect(urls).toHaveLength(1);
      expect(new URL(urls[0]!).searchParams.getAll("sources")).toEqual(values);
    },
  );

  it("rejects an invalid ticket status enum without network", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const env = await runOperation(
      "list_agent_conversation_tickets_route",
      { path: { agent_id: "agent_1" }, query: { status: "invalid" } },
      { dryRun: true },
    );
    const failure = validationOf(env);
    expect(failure.error.code).toBe("validation_error");
    expect(failure.error.param).toBe("status");
    expect(exitCodeForError(failure.error)).toBe(ExitCode.InputValidation);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([201, "201"])(
    "rejects out-of-range max_messages %j without network",
    async (maxMessages) => {
      const env = await runOperation(
        "get_conversation_summary_route",
        { path: { conversation_id: "conversation_1" }, query: { max_messages: maxMessages } },
        { dryRun: true },
      );
      const failure = validationOf(env);
      expect(failure.error.code).toBe("validation_error");
      expect(failure.error.param).toBe("max_messages");
      expect(exitCodeForError(failure.error)).toBe(ExitCode.InputValidation);
    },
  );

  it.each(["1.5", "invalid"])(
    "rejects non-integer max_messages %j without network",
    async (maxMessages) => {
      const env = await runOperation(
        "get_conversation_summary_route",
        { path: { conversation_id: "conversation_1" }, query: { max_messages: maxMessages } },
        { dryRun: true },
      );
      const failure = validationOf(env);
      expect(failure.error.param).toBe("max_messages");
      expect(exitCodeForError(failure.error)).toBe(ExitCode.InputValidation);
    },
  );

  it("accepts valid numeric-string query scalars via coercion", async () => {
    const env = await runOperation(
      "get_conversation_summary_route",
      { path: { conversation_id: "conversation_1" }, query: { max_messages: "10" } },
      { dryRun: true },
    );
    expect(env).toMatchObject({ ok: true, operation_id: "get_conversation_summary_route" });
  });

  it("accepts a valid status enum value", async () => {
    const env = await runOperation(
      "list_agent_conversation_tickets_route",
      { path: { agent_id: "agent_1" }, query: { status: "open" } },
      { dryRun: true },
    );
    expect(env).toMatchObject({ ok: true });
  });

  it("leaves unknown query params forward-compatible", async () => {
    const env = await runOperation(
      "get_conversation_summary_route",
      {
        path: { conversation_id: "conversation_1" },
        query: { max_messages: 10, some_future_flag: "x" },
      },
      { dryRun: true },
    );
    expect(env).toMatchObject({ ok: true });
  });

  it("matches known header names case-insensitively", async () => {
    const env = await runOperation(
      "get_conversation_summary_route",
      {
        path: { conversation_id: "conversation_1" },
        query: { max_messages: 10 },
        headers: { "XI-API-KEY": "test_key_CANARY" },
      },
      { dryRun: true },
    );
    expect(env).toMatchObject({ ok: true });
  });

  it("blocks invalid known-HTTP query params before fetch", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const env = await runHttp("GET", "/v1/convai/conversations/conversation_1/summary", {
      query: ["max_messages=201"],
    });
    const failure = validationOf(env);
    expect(failure.error.code).toBe("validation_error");
    expect(failure.error.param).toBe("max_messages");
    expect(exitCodeForError(failure.error)).toBe(ExitCode.InputValidation);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts valid known-HTTP query scalars", async () => {
    const env = await runHttp("GET", "/v1/convai/conversations/conversation_1/summary", {
      query: ["max_messages=10"],
      dryRun: true,
    });
    expect(env).toMatchObject({ ok: true, operation_id: "get_conversation_summary_route" });
  });

  it("keeps unknown raw HTTP permissive", async () => {
    const env = await runHttp("GET", "/v1/private/new-surface", {
      query: ["foo=bar"],
      dryRun: true,
    });
    expect(env).toMatchObject({ ok: true, operation_id: "http" });
  });
});
