import { describe, expect, it } from "vitest";
import { InputNormalizationError, normalizeInput } from "../../src/core/request-builder";
import { exitCodeForError } from "../../src/core/errors";
import { ExitCode } from "../../src/core/types";
import type { OperationCard } from "../../src/openapi/types";

function op(): OperationCard {
  return {
    operationId: "demo_op",
    method: "POST",
    pathTemplate: "/v1/items/{item_id}",
    group: ["demo"],
    tags: [],
    risk: "read",
    pathParams: [{ name: "item_id", location: "path", required: true, schema: {} }],
    queryParams: [
      { name: "page", location: "query", required: false, schema: {} },
      { name: "shared", location: "query", required: false, schema: {} },
    ],
    headerParams: [
      { name: "X-Demo", location: "header", required: false, schema: {} },
      { name: "shared", location: "header", required: false, schema: {} },
    ],
    requestBody: {
      contentType: "application/json",
      required: true,
      multipart: false,
      schema: {
        type: "object",
        properties: { name: { type: "string" }, shared: { type: "string" } },
      },
    },
    responses: [],
    returnsBinary: false,
    returnsJson: true,
    streamKind: "none",
    deprecated: false,
    examples: [],
  };
}

describe("runner input normalization", () => {
  it("routes flat keys that match exactly one declared location", () => {
    expect(normalizeInput(op(), { item_id: "i1", page: 2, name: "Ada", "X-Demo": "yes" })).toEqual({
      path: { item_id: "i1" },
      query: { page: 2 },
      headers: { "X-Demo": "yes" },
      body: { name: "Ada" },
    });
  });

  it("hard-fails ambiguous flat keys with bucketed shape and exit 2 mapping", () => {
    try {
      normalizeInput(op(), { shared: "x" });
      throw new Error("expected normalizeInput to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InputNormalizationError);
      const detail = (error as InputNormalizationError).toNormalizedError();
      expect(exitCodeForError(detail)).toBe(ExitCode.InputValidation);
      expect(detail.raw).toMatchObject({
        bucketed_shape: {
          path: {},
          query: { shared: "x" },
          headers: { shared: "x" },
          body: { shared: "x" },
        },
      });
    }
  });

  it("rejects unknown flat keys unless allowUnknown routes them to body", () => {
    expect(() => normalizeInput(op(), { missing: true })).toThrow(InputNormalizationError);
    expect(normalizeInput(op(), { missing: true }, { allowUnknown: true })).toEqual({
      body: { missing: true },
    });
  });
});
