import { describe, expect, it } from "vitest";
import { buildAjv, getInputValidator } from "../../src/openapi/ajv";
import { compileSpec } from "../../src/openapi/compile-spec";
import {
  buildExampleCommand,
  compactSchemaForOperation,
  rawInputSchemaForOperation,
} from "../../src/openapi/compact-schema";

describe("compact schema", () => {
  it("returns required and optional buckets from path/query/body input schemas", async () => {
    const compiled = await compileSpec({ sourcePath: "spec/openapi.snapshot.json" });
    const op = compiled.operations.find(
      (candidate) => candidate.operationId === "text_to_speech_full",
    );
    expect(op).toBeDefined();

    const schema = compactSchemaForOperation(op!, compiled.bundledSpec);

    expect(schema.required.path).toMatchObject({ voice_id: "string" });
    expect(schema.required.body).toMatchObject({ text: "string" });
    expect(schema.optional.query.output_format).toMatchObject({
      type: "string",
      enum: expect.arrayContaining(["mp3_44100_128"]),
    });
    expect(schema.optional.body).toMatchObject({ model_id: "string" });
  });

  it("terminates on recursive schemas", async () => {
    const compiled = await compileSpec({ sourcePath: "fixtures/fake-openapi.json" });
    const op = compiled.operations.find((candidate) => candidate.operationId === "create_item");
    expect(op).toBeDefined();

    const schema = compactSchemaForOperation(op!, compiled.bundledSpec);

    expect(JSON.stringify(schema)).toContain('"$recursive":"ItemInput"');
  });

  it("returns raw input fragments and runnable examples", async () => {
    const compiled = await compileSpec({ sourcePath: "spec/openapi.snapshot.json" });
    const op = compiled.operations.find(
      (candidate) => candidate.operationId === "text_to_speech_full",
    );
    expect(op).toBeDefined();

    const raw = rawInputSchemaForOperation(op!, compiled.bundledSpec);
    const example = buildExampleCommand(op!, compiled.bundledSpec);

    expect(raw).toMatchObject({ required: ["text"] });
    expect(example.cmd).toContain("elv call text_to_speech_full --json");
    expect(example.cmd).toContain("voice_id");
    expect(example.cmd).toContain("text");
    expect(example.cmd).toContain("--out ./out");
  });

  it("fills required shaped arrays with one placeholder item in examples", async () => {
    const compiled = await compileSpec({ sourcePath: "spec/openapi.snapshot.json" });
    for (const operationId of [
      "get_knowledge_base_bulk_dependent_agents_route",
      "post_knowledge_base_bulk_delete_route",
    ]) {
      const op = compiled.operations.find((candidate) => candidate.operationId === operationId);
      expect(op).toBeDefined();

      const example = buildExampleCommand(op!, compiled.bundledSpec);

      expect(example.cmd).toContain('"document_ids":["<document_ids>"]');
      expect(example.cmd).not.toContain('"document_ids":[]');
    }
  });

  it("marks binary CSV export examples with an output target", async () => {
    const compiled = await compileSpec({ sourcePath: "spec/openapi.snapshot.json" });
    const op = compiled.operations.find(
      (candidate) => candidate.operationId === "export_batch_call",
    );
    expect(op).toBeDefined();

    const example = buildExampleCommand(op!, compiled.bundledSpec);

    expect(example.cmd).toContain("elv call export_batch_call --json");
    expect(example.cmd).toContain('"batch_id":"<batch_id>"');
    expect(example.cmd).toContain("--out ./out");
  });

  it("recursively fills required object properties inside required arrays", async () => {
    const compiled = await compileSpec({ sourcePath: "spec/openapi.snapshot.json" });
    const op = compiled.operations.find(
      (candidate) => candidate.operationId === "get_or_create_rag_indexes",
    );
    expect(op).toBeDefined();

    const example = buildExampleCommand(op!, compiled.bundledSpec);

    expect(example.cmd).toContain(
      '"items":[{"document_id":"<document_id>","create_if_missing":false,"model":',
    );
    expect(example.cmd).not.toContain('"items":[{}]');
  });

  it("emits root oneOf object variants directly under body in examples", async () => {
    const compiled = await compileSpec({ sourcePath: "spec/openapi.snapshot.json" });

    const expectations = new Map([
      ["create_image_generation", '{"body":{"prompt":"<prompt>","model_id":"gpt-image-1"}}'],
      [
        "create_video_generation",
        '"body":{"model_id":"creatify-aurora","image":{"type":"generation","generation_id":"<generation_id>"},"audio":{"type":"generation","generation_id":"<generation_id>"}}',
      ],
      [
        "create_text_to_speech_generation",
        '{"body":{"text":"<text>","voice":"<voice>","model_id":"eleven_flash_v2_5"}}',
      ],
    ]);

    for (const [operationId, snippet] of expectations) {
      const op = compiled.operations.find((candidate) => candidate.operationId === operationId);
      expect(op).toBeDefined();

      const schema = compactSchemaForOperation(op!, compiled.bundledSpec);
      const example = buildExampleCommand(op!, compiled.bundledSpec);

      expect(schema.required.body).not.toHaveProperty("value");
      expect(example.cmd).toContain(snippet);
      expect(example.cmd).not.toContain('"value"');
    }
  });

  it("builds schema-valid examples for const-backed root unions and an existing root anyOf", async () => {
    const compiled = await compileSpec({ sourcePath: "spec/openapi.snapshot.json" });
    const ajv = buildAjv(compiled.bundledSpec);

    for (const operationId of [
      "create_image_generation",
      "create_video_generation",
      "create_text_to_speech_generation",
      "create_agent_response_test_route",
    ]) {
      const op = compiled.operations.find((candidate) => candidate.operationId === operationId);
      expect(op, operationId).toBeDefined();
      const validate = getInputValidator(ajv, op!);
      expect(validate, operationId).not.toBeNull();

      const exampleInput = JSON.parse(
        extractJsonArgument(buildExampleCommand(op!, compiled.bundledSpec).cmd),
      );

      expect(validate!(exampleInput.body), operationId).toBe(true);
    }
  });

  it("routes required multipart file fields through --file examples", async () => {
    const compiled = await compileSpec({ sourcePath: "spec/openapi.snapshot.json" });
    const op = compiled.operations.find((candidate) => candidate.operationId === "upload_asset");
    expect(op).toBeDefined();

    const example = buildExampleCommand(op!, compiled.bundledSpec);

    expect(example.cmd).toContain('{"body":{"name":"<name>"}}');
    expect(example.cmd).toContain("--file asset=./input");
    expect(example.cmd).not.toContain('"asset":"<asset>"');
  });

  it("keeps existing required multipart file examples out of the body bucket", async () => {
    const compiled = await compileSpec({ sourcePath: "spec/openapi.snapshot.json" });
    const op = compiled.operations.find((candidate) => candidate.operationId === "audio_isolation");
    expect(op).toBeDefined();

    const example = buildExampleCommand(op!, compiled.bundledSpec);

    expect(example.cmd).toContain("--file audio=./input");
    expect(example.cmd).not.toContain('"audio":"<audio>"');
  });

  it("preserves synthetic value examples for non-object root bodies", async () => {
    const compiled = await compileSpec({
      document: {
        openapi: "3.1.0",
        info: { title: "fixture", version: "1" },
        paths: {
          "/v1/raw": {
            post: {
              operationId: "raw_body",
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: { type: "string" },
                  },
                },
              },
              responses: {
                "200": {
                  description: "ok",
                  content: { "application/json": { schema: { type: "object" } } },
                },
              },
            },
          },
        },
        components: { schemas: {} },
      },
    });
    const op = compiled.operations.find((candidate) => candidate.operationId === "raw_body");
    expect(op).toBeDefined();

    const schema = compactSchemaForOperation(op!, compiled.bundledSpec);
    const example = buildExampleCommand(op!, compiled.bundledSpec);

    expect(schema.required.body).toHaveProperty("value");
    expect(example.cmd).toContain('"body":{"value":');
  });
});

function extractJsonArgument(command: string): string {
  const match = / --json '(.+)'(?: --|$)/u.exec(command);
  if (!match) throw new Error(`missing --json argument in ${command}`);
  const json = match[1];
  if (json === undefined) throw new Error(`missing --json capture in ${command}`);
  return json;
}
