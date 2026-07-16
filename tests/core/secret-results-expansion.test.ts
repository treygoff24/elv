import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildViewResult } from "../../src/commands/view";
import { redact, redactString } from "../../src/core/redaction";
import { normalizeResponse } from "../../src/core/response-normalizer";
import { ExitCode } from "../../src/core/types";
import { compileSpec } from "../../src/openapi/compile-spec";
import type { OperationCard } from "../../src/openapi/types";

function jsonOp(overrides: Partial<OperationCard> = {}): OperationCard {
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
    ...overrides,
  };
}

describe("secret result handling", () => {
  it("marks the documented token and signed-link operations as secret results", async () => {
    const compiled = await compileSpec({
      sourcePath: "spec/openapi.snapshot.json",
    });
    const byId = new Map(compiled.operations.map((op) => [op.operationId, op]));
    for (const operationId of [
      "get_single_use_token",
      "get_livekit_token",
      "get_conversation_signed_link",
    ]) {
      expect(byId.get(operationId)?.secretResult, operationId).toBe(true);
    }
    expect(byId.get("get_models")?.secretResult).toBe(false);
  });

  it("spills credentials to a collision-safe 0600 file and never returns the value inline", async () => {
    const out = mkdtempSync(join(tmpdir(), "elv-secret-"));
    const canary = "sutkn_CANARY_DO_NOT_PRINT";
    const env = await normalizeResponse(
      jsonOp(),
      new Response(JSON.stringify({ token: canary, expires_in: 900 }), {
        headers: { "content-type": "application/json" },
      }),
      { cmd: "elv call get_single_use_token", out },
    );

    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error("expected success");
    expect(env.data).toBeUndefined();
    expect(env.data_summary).toEqual({ type: "object", count: 2 });
    expect(env.files).toHaveLength(1);
    expect(env.files?.[0]?.sensitive).toBe(true);
    expect(statSync(env.files![0]!.path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(env.files![0]!.path, "utf8"))).toEqual({
      token: canary,
      expires_in: 900,
    });
    expect(JSON.stringify(env)).not.toContain(canary);

    const viewed = buildViewResult(env.files![0]!.path);
    expect(viewed.exitCode).toBe(ExitCode.InputValidation);
    expect(viewed.env.ok).toBe(false);
    expect(JSON.stringify(viewed.env)).not.toContain(canary);
    if (viewed.env.ok) throw new Error("expected view refusal");
    expect(viewed.env.error.message).toContain("Refusing to render sensitive provider response");
  });

  it("detects credential-shaped service-account responses but leaves cost metadata visible", async () => {
    const out = mkdtempSync(join(tmpdir(), "elv-service-account-secret-"));
    const secretEnv = await normalizeResponse(
      jsonOp({ operationId: "create_service_account", secretResult: false }),
      new Response(
        JSON.stringify({
          service_account_user_id: "user-1",
          api_key: "canary-key",
        }),
        {
          headers: { "content-type": "application/json" },
        },
      ),
      { cmd: "elv call create_service_account", out },
    );
    expect(secretEnv.ok && secretEnv.files?.[0]?.sensitive).toBe(true);
    expect(JSON.stringify(secretEnv)).not.toContain("canary-key");

    const ordinaryEnv = await normalizeResponse(
      jsonOp({ operationId: "get_models", method: "GET", secretResult: false }),
      new Response(JSON.stringify({ token_cost_factor: 1.25 }), {
        headers: { "content-type": "application/json" },
      }),
      { cmd: "elv call get_models", out },
    );
    expect(ordinaryEnv.ok).toBe(true);
    if (!ordinaryEnv.ok) throw new Error("expected success");
    expect(ordinaryEnv.data).toEqual({ token_cost_factor: 1.25 });
    expect(redact({ token_cost_factor: 1.25 })).toEqual({
      token_cost_factor: 1.25,
    });
    expect(
      redactString('{"signed_url":"wss://example.test?token=canary","token_cost_factor":1.25}'),
    ).toBe('{"signed_url":"[REDACTED]","token_cost_factor":1.25}');
  });

  it("tightens an existing --save-json destination instead of retaining weak permissions", async () => {
    const out = mkdtempSync(join(tmpdir(), "elv-save-secret-"));
    const saveJson = join(out, "credential.json");
    const text = JSON.stringify({
      signed_url: "wss://example.test?token=canary",
    });
    writeFileSync(saveJson, `${text}\n`);
    chmodSync(saveJson, 0o644);

    const env = await normalizeResponse(
      jsonOp({ operationId: "get_conversation_signed_link", method: "GET" }),
      new Response(text, { headers: { "content-type": "application/json" } }),
      { cmd: "elv call get_conversation_signed_link", saveJson },
    );

    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error("expected success");
    expect(env.files?.[0]?.path).toBe(saveJson);
    expect(statSync(saveJson).mode & 0o777).toBe(0o600);
  });
});
