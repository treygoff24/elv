import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileSpec } from "../../src/openapi/compile-spec";
import type { JsonObject } from "../../src/util/json";

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

    expect(compiled.totalOperations).toBe(388);
    expect(compiled.skippedOperations).toBe(1);
    expect(compiled.operations).toHaveLength(387);
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
      "resolve_conversation_reference_route",
      "create_crawl_job_route",
      "list_crawl_jobs_route",
      "get_crawl_job_route",
      "cancel_crawl_job_route",
      "get_finetunes",
      "create_finetune",
      "get_finetune",
      "update_finetune",
      "delete_finetune",
      "export_batch_call",
      "get_knowledge_base_bulk_dependent_agents_route",
      "post_knowledge_base_bulk_delete_route",
      "list_procedures_route",
      "create_procedure_route",
      "get_procedure_route",
      "remove_procedure_route",
      "get_procedure_draft_route",
      "update_procedure_draft_route",
      "delete_procedure_draft_route",
      "compile_procedures_route",
      "dubbing_transcript_segments_update",
      "dubbing_target_transcript_segments_update",
      "get_voice_accents",
      "replicate_voice_to_isolated_environment",
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
    expect(byId.get("create_finetune")?.requestBody?.fileFields).toEqual(["files"]);
  });

  it("includes the single-use STT token query parameter", async () => {
    const compiled = await compileSpec({ sourcePath: snapshotPath });

    expect(
      compiled.operations.find((op) => op.operationId === "speech_to_text")?.queryParams,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "token", location: "query" })]),
    );
  });

  it("compiles July 27 batch export and bulk knowledge-base operations", async () => {
    const compiled = await compileSpec({ sourcePath: snapshotPath });
    const byId = new Map(compiled.operations.map((op) => [op.operationId, op]));

    expect(byId.get("export_batch_call")).toMatchObject({
      method: "GET",
      pathTemplate: "/v1/convai/batch-calling/{batch_id}/export",
      risk: "read",
      returnsBinary: true,
      streamKind: "none",
      responses: expect.arrayContaining([
        expect.objectContaining({ contentType: "text/csv", binary: true }),
      ]),
    });
    expect(byId.get("get_knowledge_base_bulk_dependent_agents_route")).toMatchObject({
      method: "POST",
      risk: "read",
      requestBody: {
        schemaRef:
          "#/components/schemas/Body_Get_dependent_agents_for_multiple_documents_v1_convai_knowledge_base_dependent_agents_post",
      },
      queryParams: expect.arrayContaining([
        expect.objectContaining({ name: "cursor" }),
        expect.objectContaining({
          name: "page_size",
          schema: expect.objectContaining({ default: 30, minimum: 1, maximum: 100 }),
        }),
      ]),
    });
    expect(byId.get("post_knowledge_base_bulk_delete_route")).toMatchObject({
      method: "POST",
      pathTemplate: "/v1/convai/knowledge-base/bulk-delete",
      risk: "destructive",
      requestBody: {
        schemaRef:
          "#/components/schemas/Body_Bulk_delete_knowledge_base_documents_v1_convai_knowledge_base_bulk_delete_post",
      },
    });

    for (const schemaName of [
      "Body_Get_dependent_agents_for_multiple_documents_v1_convai_knowledge_base_dependent_agents_post",
      "Body_Bulk_delete_knowledge_base_documents_v1_convai_knowledge_base_bulk_delete_post",
    ]) {
      expect(compiled.bundledSpec.components.schemas[schemaName]).toMatchObject({
        required: ["document_ids"],
        properties: {
          document_ids: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 20,
            uniqueItems: true,
          },
        },
      });
    }
  });

  it("compiles August 11 procedures, Dubbing v2, voice, and media metadata", async () => {
    const compiled = await compileSpec({ sourcePath: snapshotPath });
    const byId = new Map(compiled.operations.map((op) => [op.operationId, op]));
    const augustOperationIds = [
      "list_procedures_route",
      "create_procedure_route",
      "get_procedure_route",
      "remove_procedure_route",
      "get_procedure_draft_route",
      "update_procedure_draft_route",
      "delete_procedure_draft_route",
      "compile_procedures_route",
      "dubbing_transcript_segments_update",
      "dubbing_target_transcript_segments_update",
      "get_voice_accents",
      "replicate_voice_to_isolated_environment",
    ];

    expect(augustOperationIds.every((id) => byId.has(id))).toBe(true);
    expect(byId.get("replicate_voice_to_isolated_environment")).toMatchObject({
      method: "POST",
      pathTemplate: "/v1/voices/{voice_id}/replicate-to-isolated-environment",
      risk: "external_side_effect",
    });
    for (const operationId of ["remove_procedure_route", "delete_procedure_draft_route"]) {
      expect(byId.get(operationId)).toMatchObject({ method: "DELETE", risk: "destructive" });
    }
    expect(byId.get("dubbing_target_transcript_regenerate")?.responses).toContainEqual(
      expect.objectContaining({
        status: "202",
        contentType: "application/json",
        schema: { $ref: "#/components/schemas/DubbingRegenerateResponse" },
        binary: false,
      }),
    );
    expect(byId.get("video_to_music")).toMatchObject({
      returnsBinary: true,
      responses: expect.arrayContaining([
        expect.objectContaining({ status: "200", contentType: "audio/*", binary: true }),
        expect.objectContaining({
          status: "200",
          contentType: "application/zip",
          binary: true,
        }),
      ]),
    });
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
    const spec = JSON.parse(readFileSync(fixturePath, "utf8")) as JsonObject;
    const paths = spec.paths as Record<string, Record<string, { operationId?: string }>>;
    const itemPost = paths["/v1/items"]?.post;
    expect(itemPost).toBeDefined();
    itemPost!.operationId = "list_voices";

    await expect(compileSpec({ document: spec })).rejects.toThrow(/Duplicate operationId/iu);
  });
});
