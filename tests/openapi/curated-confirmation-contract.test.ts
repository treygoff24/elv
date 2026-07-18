import { afterEach, describe, expect, it, vi } from "vitest";
import { runHttp } from "../../src/commands/http";
import { runPreparedOperation } from "../../src/core/client";
import { requiresYes } from "../../src/core/safety";
import { compileSpec } from "../../src/openapi/compile-spec";
import { riskCurationInputs } from "../../src/openapi/risk";
import { errorRecord, parseEnvelope, runCli } from "../helpers/cli-result";
import type { AgentInput } from "../../src/core/types";

afterEach(() => vi.unstubAllGlobals());

function concretePath(template: string): string {
  return template.replace(/\{[^}]+\}/gu, "test-id");
}

describe("curated confirmation contract", () => {
  it("gates every curated destructive and external-side-effect operation through call and raw HTTP", async () => {
    const { destructiveOperationIds, externalSideEffectOperationIds } = riskCurationInputs();
    const ids = [...destructiveOperationIds, ...externalSideEffectOperationIds];
    const compiled = await compileSpec({ sourcePath: "spec/openapi.snapshot.json" });
    const byId = new Map(
      compiled.operations.map((operation) => [operation.operationId, operation]),
    );
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    for (const operationId of ids) {
      const op = byId.get(operationId);
      expect(op, operationId).toBeDefined();
      expect(requiresYes(op!), operationId).toBe(true);

      const call = await runPreparedOperation({
        cmd: `elv call ${operationId}`,
        op: op!,
        input: {} as AgentInput,
        opts: {},
        command: { kind: "call" },
        dryRunRequest: {
          operation_id: operationId,
          method: op!.method,
          path: op!.pathTemplate,
          input: {},
        },
        creditsEstimated: null,
      });
      expect(call.ok ? undefined : call.error.code, `${operationId} call`).toBe("confirmation");

      const raw = await runHttp(op!.method, concretePath(op!.pathTemplate));
      expect(raw.ok ? undefined : raw.error.code, `${operationId} http`).toBe("confirmation");
    }
    expect(fetch).not.toHaveBeenCalled();
  }, 30_000);

  it.each([
    ["history delete", ["history", "delete", "--id", "history-id"]],
    ["agent test delete", ["agents", "tests", "delete", "--test-id", "test-id"]],
    [
      "dubbing transcript delete",
      [
        "dubbing-project",
        "transcript",
        "delete-segment",
        "--project-id",
        "project-id",
        "--segment-id",
        "segment-id",
      ],
    ],
    ["service account create", ["workspace", "service-accounts", "create", "--name", "CI"]],
  ])("gates the %s alias", async (_name, args) => {
    const result = await runCli(args);
    expect(result.code).toBe(4);
    expect(errorRecord(parseEnvelope(result.stdout)).code).toBe("confirmation");
  });
});
