import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addPaginationToEnvelope,
  applyPaginationDefaults,
  collectAllPages,
  nextCursor,
} from "../../src/core/pagination";
import { success } from "../../src/core/envelope";
import type { Envelope } from "../../src/core/types";
import type { OperationCard } from "../../src/openapi/types";
import type { JsonValue } from "../../src/util/json";

function op(overrides: Partial<OperationCard>): OperationCard {
  return {
    operationId: "demo",
    method: "GET",
    pathTemplate: "/v1/demo",
    group: [],
    tags: [],
    risk: "read",
    pathParams: [],
    queryParams: [],
    headerParams: [],
    responses: [{ status: "200", contentType: "application/json", binary: false }],
    returnsBinary: false,
    returnsJson: true,
    streamKind: "none",
    deprecated: false,
    examples: [],
    ...overrides,
  };
}

function ok(data: JsonValue): Envelope {
  return success({ cmd: "elv call demo", operation_id: "demo", data, truncated: false, hints: [] });
}

describe("pagination cursor derivation", () => {
  it("caps automatic page sizes at the provider maximum without changing explicit input", () => {
    const schemas: JsonValue[] = [
      { type: "integer", maximum: 100 },
      { anyOf: [{ type: "integer", maximum: 100 }, { type: "null" }] },
    ];
    for (const schema of schemas) {
      const operation = op({
        queryParams: [{ name: "page_size", location: "query", required: false, schema }],
      });
      expect(applyPaginationDefaults(operation, {}, 500)).toEqual({ query: { page_size: 100 } });
      expect(applyPaginationDefaults(operation, {}, 5)).toEqual({ query: { page_size: 5 } });
      expect(applyPaginationDefaults(operation, { query: { page_size: 500 } }, 5)).toEqual({
        query: { page_size: 500 },
      });
    }
  });
  it("derives history next cursor and default page_size", () => {
    const operation = op({ operationId: "get_speech_history", pathTemplate: "/v1/history" });
    expect(applyPaginationDefaults(operation, {})).toEqual({ query: { page_size: 20 } });
    expect(nextCursor(operation, { has_more: true, last_history_item_id: "hist_2" })).toMatchObject(
      {
        hasMore: true,
        cursorParam: "start_after_history_item_id",
        cursor: "hist_2",
      },
    );
  });

  it("derives v2 voices next_page_token", () => {
    const operation = op({ operationId: "get_user_voices_v2", pathTemplate: "/v2/voices" });
    const env = addPaginationToEnvelope(
      ok({ voices: [{ voice_id: "v1" }], has_more: true, next_page_token: "tok_2" }),
      operation,
      { query: { page_size: 20 } },
      { command: { kind: "call" } },
    );
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error("expected success");
    expect(JSON.stringify(env.data)).toContain("next_page_token");
    expect(JSON.stringify(env.data)).toContain("tok_2");
  });

  it("derives ConvAI cursor", () => {
    const operation = op({ operationId: "get_agents_route", pathTemplate: "/v1/convai/agents" });
    expect(nextCursor(operation, { has_more: true, next_cursor: "cur_2" })).toMatchObject({
      cursorParam: "cursor",
      cursor: "cur_2",
    });
  });

  it("follows crawl next_cursor without has_more but honors explicit false", () => {
    const operation = op({
      operationId: "list_crawl_jobs_route",
      pathTemplate: "/v1/convai/knowledge-base/crawl",
      queryParams: [
        {
          name: "cursor",
          location: "query",
          required: false,
          schema: { type: "string" },
        },
      ],
    });
    expect(nextCursor(operation, { crawl_jobs: [{ id: "job_1" }], next_cursor: "cur_2" })).toEqual({
      hasMore: true,
      cursorParam: "cursor",
      cursor: "cur_2",
      warnings: [],
    });
    expect(
      nextCursor(operation, {
        crawl_jobs: [{ id: "job_1" }],
        next_cursor: "cur_2",
        has_more: false,
      }),
    ).toEqual({ hasMore: false, warnings: [] });
  });

  it("does not treat subscription next_* fields as cursors", () => {
    const operation = op({
      operationId: "get_user_subscription_info",
      pathTemplate: "/v1/user/subscription",
    });
    const data = {
      next_character_count_reset_unix: 1_800_000_000,
      next_invoice: { amount_due_cents: 1000 },
    };

    expect(nextCursor(operation, data)).toEqual({ hasMore: false, warnings: [] });
    const env = addPaginationToEnvelope(ok(data), operation, {}, { command: { kind: "call" } });
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error("expected success");
    expect(JSON.stringify(env.data)).not.toContain('"next"');
  });

  it("warns instead of inventing a next command when has_more has no cursor", () => {
    const operation = op({ operationId: "unknown_page", pathTemplate: "/v1/unknown" });
    const env = addPaginationToEnvelope(
      ok({ items: [1], has_more: true }),
      operation,
      {},
      { command: { kind: "call" } },
    );
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error("expected success");
    expect(env.warnings?.[0]?.code).toBe("pagination_cursor_missing");
    expect(JSON.stringify(env.data)).not.toContain('"next"');
  });

  it("preserves raw HTTP POST bodies in cursor next commands", () => {
    const operation = op({
      operationId: "get_knowledge_base_bulk_dependent_agents_route",
      method: "POST",
      pathTemplate: "/v1/convai/knowledge-base/dependent-agents",
      queryParams: [
        { name: "page_size", location: "query", required: false, schema: { type: "integer" } },
        { name: "cursor", location: "query", required: false, schema: { type: "string" } },
      ],
    });
    const env = addPaginationToEnvelope(
      ok({ agents: [], branches: [], has_more: true, next_cursor: "cur_2" }),
      operation,
      { query: { page_size: 20 }, body: { document_ids: ["doc_1"] } },
      {
        command: {
          kind: "http",
          method: "POST",
          path: "/v1/convai/knowledge-base/dependent-agents",
        },
      },
    );

    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error("expected success");
    const command = (env.data as { next: { cmd: string } }).next.cmd;
    expect(command).toContain("--query 'cursor=cur_2'");
    expect(command).toContain("--body-json");
    expect(command).toContain('{"document_ids":["doc_1"]}');
  });

  it("--all terminates on repeated cursor and emits the 1000-page cap warning", async () => {
    const out = mkdtempSync(join(tmpdir(), "elv-pages-"));
    try {
      const operation = op({ operationId: "get_user_voices_v2", pathTemplate: "/v2/voices" });
      let calls = 0;
      const env = await collectAllPages({
        op: operation,
        input: {},
        out,
        command: { kind: "call" },
        fetchPage: async () => {
          calls += 1;
          return ok({
            voices: [{ voice_id: `v${calls}` }],
            has_more: true,
            next_page_token: String(calls),
          });
        },
        maxPages: 3,
      });

      expect(env.ok).toBe(true);
      if (!env.ok) throw new Error("expected success");
      expect(calls).toBe(3);
      expect(env.warnings?.some((warning) => warning.code === "pagination_page_cap_hit")).toBe(
        true,
      );
      expect(env.files).toHaveLength(1);
      expect(JSON.parse(readFileSync(env.files![0]!.path, "utf8"))).toHaveLength(3);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("--all on non-paginated v1 voices fetches once", async () => {
    const out = mkdtempSync(join(tmpdir(), "elv-pages-"));
    try {
      const operation = op({ operationId: "get_voices", pathTemplate: "/v1/voices" });
      let calls = 0;
      await collectAllPages({
        op: operation,
        input: {},
        out,
        command: { kind: "call" },
        fetchPage: async () => {
          calls += 1;
          return ok({ voices: [{ voice_id: "v1" }] });
        },
      });
      expect(calls).toBe(1);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("--all collects crawl pages that omit has_more", async () => {
    const out = mkdtempSync(join(tmpdir(), "elv-pages-"));
    try {
      const operation = op({
        operationId: "list_crawl_jobs_route",
        pathTemplate: "/v1/convai/knowledge-base/crawl",
        queryParams: [
          {
            name: "page_size",
            location: "query",
            required: false,
            schema: { type: "integer" },
          },
          {
            name: "cursor",
            location: "query",
            required: false,
            schema: { type: "string" },
          },
        ],
      });
      const inputs: unknown[] = [];
      const env = await collectAllPages({
        op: operation,
        input: {},
        out,
        command: { kind: "call" },
        fetchPage: async (input) => {
          inputs.push(input);
          return input.query?.cursor === "cur_2"
            ? ok({ crawl_jobs: [{ id: "job_2" }], next_cursor: null })
            : ok({ crawl_jobs: [{ id: "job_1" }], next_cursor: "cur_2" });
        },
      });

      expect(inputs).toEqual([
        { query: { page_size: 20 } },
        { query: { page_size: 20, cursor: "cur_2" } },
      ]);
      expect(env.ok).toBe(true);
      if (!env.ok) throw new Error("expected success");
      expect(JSON.parse(readFileSync(env.files![0]!.path, "utf8"))).toEqual([
        { id: "job_1" },
        { id: "job_2" },
      ]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("--all preserves both agents and branches from bulk dependent-agent pages", async () => {
    const out = mkdtempSync(join(tmpdir(), "elv-pages-"));
    try {
      const operation = op({
        operationId: "get_knowledge_base_bulk_dependent_agents_route",
        method: "POST",
        pathTemplate: "/v1/convai/knowledge-base/dependent-agents",
        queryParams: [
          {
            name: "page_size",
            location: "query",
            required: false,
            schema: { type: "integer" },
          },
          { name: "cursor", location: "query", required: false, schema: { type: "string" } },
        ],
      });
      const inputs: unknown[] = [];
      const env = await collectAllPages({
        op: operation,
        input: { body: { document_ids: ["doc_1"] } },
        out,
        command: { kind: "call" },
        fetchPage: async (input) => {
          inputs.push(input);
          return input.query?.cursor === "cur_2"
            ? ok({
                agents: [{ agent_id: "agent_2" }],
                branches: [{ branch_id: "branch_2" }],
                has_more: false,
              })
            : ok({
                agents: [{ agent_id: "agent_1" }],
                branches: [{ branch_id: "branch_1" }],
                has_more: true,
                next_cursor: "cur_2",
              });
        },
      });

      expect(inputs).toEqual([
        { body: { document_ids: ["doc_1"] }, query: { page_size: 20 } },
        { body: { document_ids: ["doc_1"] }, query: { page_size: 20, cursor: "cur_2" } },
      ]);
      expect(env.ok).toBe(true);
      if (!env.ok) throw new Error("expected success");
      expect(JSON.parse(readFileSync(env.files![0]!.path, "utf8"))).toEqual([
        { agent_id: "agent_1" },
        { branch_id: "branch_1" },
        { agent_id: "agent_2" },
        { branch_id: "branch_2" },
      ]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
