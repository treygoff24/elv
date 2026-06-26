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
});
