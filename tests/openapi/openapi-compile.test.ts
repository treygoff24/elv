import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileSpec } from "../../src/openapi/compile-spec";

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

    expect(compiled.totalOperations).toBe(339);
    expect(compiled.skippedOperations).toBe(1);
    expect(compiled.operations).toHaveLength(338);
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

  it("matches the pinned snapshot metadata and includes the current operations", async () => {
    const bytes = readFileSync(snapshotPath);
    const metadata = JSON.parse(readFileSync("spec/openapi.snapshot.meta.json", "utf8")) as {
      sha256: string;
      paths: number;
      total_operations: number;
      callable_operations: number;
      skipped_operations: number;
      schemas: number;
    };
    const compiled = await compileSpec({ sourcePath: snapshotPath });
    const ids = new Set(compiled.operations.map(({ operationId }) => operationId));
    const currentIds = [
      "compose_detailed_stream",
      "create_service_account",
      "get_workspace_members",
      "query_agent_knowledge_base_rag_route",
      "dubbing_project_create",
      "dubbing_project_list",
      "dubbing_project_get",
      "dubbing_project_delete",
      "dubbing_language_create",
      "dubbing_language_list",
      "dubbing_language_get",
      "dubbing_language_delete",
      "dubbing_transcript_get",
      "dubbing_transcript_segment_add",
      "dubbing_transcript_segment_update",
      "dubbing_transcript_segment_delete",
      "dubbing_target_transcript_get",
      "dubbing_target_transcript_segment_update",
      "dubbing_target_transcript_regenerate",
    ];
    const aliasIds = [
      "add_voice",
      "audio_isolation",
      "create_agent_route",
      "create_dubbing",
      "delete_speech_history_item",
      "generate",
      "get_agent_route",
      "get_agents_route",
      "get_audio_full_from_speech_history_item",
      "get_dubbed_file",
      "get_dubbed_metadata",
      "get_models",
      "get_speech_history",
      "get_user_subscription_info",
      "get_user_voices_v2",
      "get_voice_by_id",
      "list_dubs",
      "patch_agent_settings_route",
      "run_conversation_simulation_route",
      "sound_generation",
      "speech_to_speech_full",
      "speech_to_speech_stream",
      "speech_to_text",
      "stream_compose",
      "text_to_speech_full",
      "text_to_speech_full_with_timestamps",
      "text_to_speech_stream",
      "text_to_speech_stream_with_timestamps",
      "usage_characters",
    ];

    expect(createHash("sha256").update(bytes).digest("hex")).toBe(metadata.sha256);
    expect(Object.keys(compiled.bundledSpec.paths)).toHaveLength(metadata.paths);
    expect(compiled.totalOperations).toBe(metadata.total_operations);
    expect(compiled.operations).toHaveLength(metadata.callable_operations);
    expect(compiled.skippedOperations).toBe(metadata.skipped_operations);
    expect(Object.keys(compiled.bundledSpec.components.schemas)).toHaveLength(metadata.schemas);
    expect(currentIds.every((id) => ids.has(id))).toBe(true);
    expect(aliasIds.every((id) => ids.has(id))).toBe(true);
  });

  it("detects array binary multipart fields", async () => {
    const compiled = await compileSpec({ sourcePath: snapshotPath });
    const byId = new Map(compiled.operations.map((op) => [op.operationId, op]));

    expect(byId.get("add_voice")?.requestBody?.fileFields).toEqual(["files"]);
    expect(byId.get("add_pvc_voice_samples")?.requestBody?.fileFields).toEqual(["files"]);
    expect(byId.get("edit_voice")?.requestBody?.fileFields).toEqual(["files"]);
    expect(byId.get("request_pvc_manual_verification")?.requestBody?.fileFields).toEqual(["files"]);
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
