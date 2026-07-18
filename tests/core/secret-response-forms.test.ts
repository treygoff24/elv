import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeResponse } from "../../src/core/response-normalizer";
import type { OperationCard } from "../../src/openapi/types";

const canary = "credential_CANARY_secret_response";

function secretOp(): OperationCard {
  return {
    operationId: "get_single_use_token",
    method: "POST",
    pathTemplate: "/v1/single-use-token/{token_type}",
    group: [],
    tags: [],
    risk: "mutate",
    pathParams: [],
    queryParams: [],
    headerParams: [],
    responses: [{ status: "200", contentType: "application/json", binary: false }],
    returnsBinary: false,
    returnsJson: true,
    streamKind: "none",
    secretResult: true,
    deprecated: false,
    examples: [],
  };
}

describe("secret results in non-JSON response forms", () => {
  it("protects a secret JSON result when content-type is missing", async () => {
    const response = new Response(JSON.stringify({ token: canary }));
    response.headers.delete("content-type");
    const env = await normalizeResponse(secretOp(), response, {
      cmd: "elv call get_single_use_token",
      out: mkdtempSync(join(tmpdir(), "elv-secret-form-")),
    });

    expect(JSON.stringify(env)).not.toContain(canary);
    expect(env.ok && env.files?.[0]?.sensitive).toBe(true);
  });
});
