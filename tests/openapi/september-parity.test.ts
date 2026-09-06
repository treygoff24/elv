import { describe, expect, it } from "vitest";
import { compileSpec } from "../../src/openapi/compile-spec";
import { buildAjv, getInputValidator } from "../../src/openapi/ajv";
import { budgetDecision, estimateCredits } from "../../src/core/budget";

describe("September public API contract", () => {
  it("compiles a validator for every documented request body", async () => {
    const compiled = await compileSpec();
    const ajv = buildAjv(compiled.bundledSpec);
    for (const op of compiled.operations.filter((op) => op.requestBody)) {
      expect(() => getInputValidator(ajv, op), op.operationId).not.toThrow();
      expect(getInputValidator(ajv, op), op.operationId).not.toBeNull();
    }
  });

  it("classifies asynchronous Flows generation without inventing a cost estimate", async () => {
    const compiled = await compileSpec();
    for (const kind of ["image", "video", "text_to_speech"]) {
      const op = compiled.operations.find(
        (candidate) => candidate.operationId === `create_${kind}_generation`,
      )!;
      expect(op, kind).toMatchObject({ risk: "generate", costHint: "per_generation" });
      const estimate = await estimateCredits(op, { body: { text: "Hello" } }, {});
      expect(estimate).toBeNull();
      expect(budgetDecision(op, estimate, { maxCredits: 100, yes: true })).toEqual({
        policy: "estimate_unavailable",
        wouldExceed: true,
      });
      expect(budgetDecision(op, estimate, {})).toEqual({
        policy: "not_configured",
        wouldExceed: false,
      });
      expect(
        compiled.operations.find((candidate) => candidate.operationId === `get_${kind}_generation`),
      ).toMatchObject({ risk: "read" });
    }
    expect(
      compiled.operations.find((op) => op.operationId === "delete_asset_endpoint"),
    ).toMatchObject({ risk: "destructive" });
  });
});
