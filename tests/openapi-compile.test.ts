import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileSpec } from "../src/openapi/compile-spec";

const snapshotPath = "spec/openapi.snapshot.json";
const fixturePath = "fixtures/fake-openapi.json";

describe("OpenAPI compiler", () => {
  it("compiles the small fixture into operation cards", async () => {
    const compiled = await compileSpec({ sourcePath: fixturePath });
    const byId = new Map(compiled.operations.map((op) => [op.operationId, op]));

    expect(compiled.totalOperations).toBe(4);
    expect(compiled.skippedOperations).toBe(0);
    expect(byId.get("list_voices")).toMatchObject({ method: "GET", risk: "read" });
    expect(byId.get("create_item")?.requestBody).toMatchObject({
      contentType: "application/json",
      schemaRef: "#/components/schemas/ItemInput",
      multipart: false,
    });
    expect(byId.get("upload_sample")?.requestBody).toMatchObject({
      contentType: "multipart/form-data",
      multipart: true,
      fileFields: ["file"],
    });
    expect(byId.get("text_to_speech_fake")).toMatchObject({
      returnsBinary: true,
      returnsJson: false,
    });
  });

  it("discovers all snapshot operations, excludes x-skip-spec, and serializes cleanly", async () => {
    const compiled = await compileSpec({ sourcePath: snapshotPath });
    const ids = compiled.operations.map((op) => op.operationId);

    expect(compiled.totalOperations).toBe(320);
    expect(compiled.skippedOperations).toBe(1);
    expect(compiled.operations).toHaveLength(319);
    expect(new Set(ids).size).toBe(ids.length);
    expect(() => JSON.stringify(compiled.operations)).not.toThrow();

    const tts = compiled.operations.find((op) => op.operationId === "text_to_speech_full");
    expect(tts).toMatchObject({
      method: "POST",
      pathTemplate: "/v1/text-to-speech/{voice_id}",
      risk: "generate",
      costHint: "characters",
      returnsBinary: true,
      streamKind: "none",
    });
    expect(tts?.pathParams.map((param) => param.name)).toContain("voice_id");
    expect(tts?.requestBody?.schemaRef).toBe("#/components/schemas/Body_text_to_speech_full");
  });

  it("detects array binary multipart fields", async () => {
    const compiled = await compileSpec({ sourcePath: snapshotPath });
    const byId = new Map(compiled.operations.map((op) => [op.operationId, op]));

    expect(byId.get("add_voice")?.requestBody?.fileFields).toEqual(["files"]);
    expect(byId.get("add_pvc_voice_samples")?.requestBody?.fileFields).toEqual(["files"]);
    expect(byId.get("edit_voice")?.requestBody?.fileFields).toEqual(["files"]);
    expect(byId.get("request_pvc_manual_verification")?.requestBody?.fileFields).toEqual([
      "files",
    ]);
    expect(byId.get("video_to_music")?.requestBody?.fileFields).toEqual(["videos"]);
  });

  it("bundles instead of dereferencing recursive schemas", async () => {
    const compiled = await compileSpec({ sourcePath: snapshotPath });
    const recursive = JSON.stringify(
      compiled.bundledSpec.components.schemas["ArrayJsonSchemaProperty-Input"],
    );

    expect(recursive).toContain("#/components/schemas/ArrayJsonSchemaProperty-Input");
    expect(() => JSON.stringify(compiled.bundledSpec)).not.toThrow();
  });

  it("throws on duplicate operationIds", async () => {
    const spec = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
    const paths = spec.paths as Record<string, Record<string, { operationId?: string }>>;
    const itemPost = paths["/v1/items"]?.post;
    expect(itemPost).toBeDefined();
    itemPost!.operationId = "list_voices";

    await expect(compileSpec({ document: spec })).rejects.toThrow(/Duplicate operationId/iu);
  });
});
