import { describe, expect, it } from "vitest";
import { budgetDecision } from "../../src/core/budget";
import type { OperationCard } from "../../src/openapi/types";

function operation(risk: OperationCard["risk"]): OperationCard {
  return {
    operationId: "test",
    method: "POST",
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

describe("budget policy decisions", () => {
  it("distinguishes bounded, unavailable generation, and honest unbounded costs", () => {
    expect(budgetDecision(operation("generate"), 5, { maxCredits: 4 })).toEqual({
      policy: "bounded",
      wouldExceed: true,
    });
    expect(budgetDecision(operation("generate"), null, { maxCredits: 4 })).toEqual({
      policy: "estimate_unavailable",
      wouldExceed: true,
    });
    expect(budgetDecision(operation("read"), null, { maxCredits: 4 })).toEqual({
      policy: "unknown_unbounded",
      wouldExceed: null,
    });
    expect(budgetDecision(operation("generate"), null, {})).toEqual({
      policy: "not_configured",
      wouldExceed: false,
    });
  });
});
