import { describe, expect, it } from "vitest";
import { requiresYes } from "../src/core/safety";
import type { OperationCard, Risk } from "../src/core/types";

function op(
  operationId: string,
  risk: Risk,
  method: OperationCard["method"] = "POST",
): OperationCard {
  return {
    operationId,
    method,
    pathTemplate: "/test",
    group: [],
    tags: [],
    risk,
    pathParams: [],
    queryParams: [],
    headerParams: [],
    responses: [],
    returnsBinary: false,
    returnsJson: true,
    streamKind: "none",
    deprecated: false,
    examples: [],
  };
}

describe("safety gate", () => {
  it("requires --yes for destructive and external side-effect operations", () => {
    expect(requiresYes(op("delete_voice", "destructive", "DELETE"))).toBe(true);
    expect(requiresYes(op("create_batch_call", "external_side_effect"))).toBe(true);
  });

  it("does not require --yes for reads or plain mutations", () => {
    expect(requiresYes(op("get_voices", "read", "GET"))).toBe(false);
    expect(requiresYes(op("update_voice", "mutate"))).toBe(false);
  });
});
