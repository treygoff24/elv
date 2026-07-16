import { describe, expect, it } from "vitest";
import { buildAjv, getInputValidator } from "../../src/openapi/ajv";
import { compileSpec } from "../../src/openapi/compile-spec";

describe("Ajv 2020 validator", () => {
  it("validates good TTS bodies and rejects bad ones by component $ref", async () => {
    const compiled = await compileSpec({ sourcePath: "spec/openapi.snapshot.json" });
    const op = compiled.operations.find(
      (candidate) => candidate.operationId === "text_to_speech_full",
    );
    expect(op).toBeDefined();

    const ajv = buildAjv(compiled.bundledSpec);
    const validate = getInputValidator(ajv, op!);

    expect(validate).not.toBeNull();
    expect(validate!({ text: "Hello." })).toBe(true);
    expect(validate!({ model_id: "eleven_multilingual_v2" })).toBe(false);
  });

  it("compiles inline request body schemas", async () => {
    const compiled = await compileSpec({ sourcePath: "fixtures/fake-openapi.json" });
    const op = compiled.operations.find(
      (candidate) => candidate.operationId === "text_to_speech_fake",
    );
    expect(op).toBeDefined();

    const validate = getInputValidator(buildAjv(compiled.bundledSpec), op!);

    expect(validate).not.toBeNull();
    expect(validate!({ text: "hi" })).toBe(true);
    expect(validate!({})).toBe(false);
  });

  it("resolves document-local refs nested in polymorphic request schemas", async () => {
    const compiled = await compileSpec({ sourcePath: "spec/openapi.snapshot.json" });
    const testsCreate = compiled.operations.find(
      (candidate) => candidate.operationId === "create_agent_response_test_route",
    );
    const authCreate = compiled.operations.find(
      (candidate) => candidate.operationId === "create_auth_connection",
    );

    const ajv = buildAjv(compiled.bundledSpec);
    const validateTest = getInputValidator(ajv, testsCreate!);
    const validateAuth = getInputValidator(ajv, authCreate!);

    expect(validateTest!({ name: "Refund" })).toBe(true);
    expect(
      validateAuth!({
        name: "CI OAuth",
        auth_type: "oauth2_client_credentials",
        provider: "custom",
        client_id: "client",
        token_url: "https://example.test/token",
        client_secret: "secret",
      }),
    ).toBe(true);
  });
});
