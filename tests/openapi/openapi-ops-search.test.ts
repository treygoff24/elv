import { describe, expect, it } from "vitest";
import { compileSpec } from "../../src/openapi/compile-spec";
import { searchOperations } from "../../src/commands/ops";

describe("ops search ranking", () => {
  it("ranks text_to_speech_full at the top for text to speech", async () => {
    const compiled = await compileSpec({ sourcePath: "spec/openapi.snapshot.json" });
    const registry = new Map(compiled.operations.map((op) => [op.operationId, op]));

    const results = searchOperations(registry, "text to speech", 10);

    expect(results[0]?.operation_id).toBe("text_to_speech_full");
    expect(results.map((result) => result.operation_id)).toContain("text_to_speech_full");
  });

  it("searches by path, group, tags, summary, and description", async () => {
    const compiled = await compileSpec({ sourcePath: "fixtures/fake-openapi.json" });
    const registry = new Map(compiled.operations.map((op) => [op.operationId, op]));

    expect(searchOperations(registry, "/v1/voices", 1)[0]?.operation_id).toBe("list_voices");
    expect(searchOperations(registry, "nested item", 1)[0]?.operation_id).toBe("create_item");
    expect(searchOperations(registry, "binary sample", 1)[0]?.operation_id).toBe("upload_sample");
  });
});
