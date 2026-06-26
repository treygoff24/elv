import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addPaginationToEnvelope,
  applyPaginationDefaults,
  collectAllPages,
  nextCursor,
} from "../src/core/pagination";
import { success } from "../src/core/envelope";
import type { Envelope, OperationCard } from "../src/core/types";

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

function ok(data: unknown): Envelope {
  return success({ cmd: "elv call demo", operation_id: "demo", data, truncated: false, hints: [] });
}

describe("pagination cursor derivation", () => {
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
});
