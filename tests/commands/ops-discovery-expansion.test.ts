import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  handleOpsGet,
  handleOpsList,
  handleOpsSchema,
  listOperations,
  searchOperations,
} from "../../src/commands/ops";
import type { OperationCard } from "../../src/openapi/types";

function operation(operationId: string, overrides: Partial<OperationCard> = {}): OperationCard {
  return {
    operationId,
    method: "GET",
    pathTemplate: `/v1/${operationId}`,
    group: ["voices"],
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
    ...overrides,
  };
}

describe("expanded operation discovery", () => {
  const previousCache = process.env.ELV_CACHE_DIR;

  beforeEach(() => {
    process.env.ELV_CACHE_DIR = mkdtempSync(join(tmpdir(), "elv-ops-expanded-"));
  });

  afterEach(() => {
    if (previousCache === undefined) delete process.env.ELV_CACHE_DIR;
    else process.env.ELV_CACHE_DIR = previousCache;
  });

  it("lists stable bounded operation items and applies every filter", () => {
    const registry = new Map(
      [
        operation("z_read"),
        operation("a_upload", {
          method: "POST",
          group: ["speech_to_text"],
          risk: "generate",
          streamKind: "json_events",
          costHint: "audio_seconds",
          deprecated: true,
          requestBody: {
            contentType: "multipart/form-data",
            required: true,
            multipart: true,
            fileFields: ["file"],
          },
        }),
      ].map((entry) => [entry.operationId, entry]),
    );

    const all = listOperations(registry, { deprecated: false, uploads: false, limit: 100 });
    expect(all.map((entry) => entry.operation_id)).toEqual(["a_upload", "z_read"]);
    expect(all[0]).toMatchObject({
      method: "POST",
      path: "/v1/a_upload",
      group: ["speech_to_text"],
      risk: "generate",
      stream: "json_events",
      cost_hint: "audio_seconds",
      deprecated: true,
      upload_fields: ["file"],
    });

    const filters = [
      { group: "speech_to_text" },
      { method: "POST" as const },
      { risk: "generate" as const },
      { stream: "json_events" as const },
      { cost: "audio_seconds" as const },
      { deprecated: true },
      { uploads: true },
    ];
    for (const filter of filters) {
      expect(
        listOperations(registry, {
          deprecated: false,
          uploads: false,
          limit: 100,
          ...filter,
        }).map((entry) => entry.operation_id),
      ).toEqual(["a_upload"]);
    }
  });

  it("returns a successful empty contract for a valid unmatched filter", async () => {
    const result = await handleOpsList({ group: "definitely_not_a_real_group", limit: 5 });
    expect(result.exitCode).toBe(0);
    expect(result.env).toMatchObject({
      ok: true,
      data: { items: [], count: 0, total_matches: 0, limit: 5 },
    });
  });

  it("validates list filters before loading the registry", async () => {
    const result = await handleOpsList({ method: "TRACE", limit: 501 });
    expect(result.exitCode).toBe(2);
    expect(result.env).toMatchObject({ ok: false });
  });

  it("adds cost and deprecation metadata to search results", () => {
    const card = operation("legacy_voice", {
      summary: "Legacy voice endpoint",
      costHint: "slot",
      deprecated: true,
    });
    const results = searchOperations(new Map([[card.operationId, card]]), "legacy voice");
    expect(results).toEqual([
      expect.objectContaining({
        operation_id: "legacy_voice",
        cost_hint: "slot",
        deprecated: true,
      }),
    ]);
  });

  it("warns on deprecated get and schema responses and points to a named replacement", async () => {
    const get = await handleOpsGet("text_to_voice");
    const schema = await handleOpsSchema("text_to_voice");
    for (const result of [get, schema]) {
      expect(result.exitCode).toBe(0);
      expect(result.env).toMatchObject({
        ok: true,
        warnings: [{ code: "deprecated_operation" }],
      });
      expect(result.env.hints?.[0]?.cmd).toContain("POST /v1/text-to-voice/design");
    }
  });
});
