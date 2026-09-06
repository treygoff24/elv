import { spawnSync } from "node:child_process";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { compileSpec } from "../../src/openapi/compile-spec";
import { buildAjv, getInputValidator } from "../../src/openapi/ajv";
import type { JsonObject, JsonValue } from "../../src/util/json";
import {
  buildExampleCommand,
  compactSchemaForOperation,
  rawInputSchemaForOperation,
} from "../../src/openapi/compact-schema";

function exampleArgs(cmd: string): string[] {
  const result = spawnSync("sh", ["-c", `elv() { printf '%s\\0' "$@"; }; ${cmd}`], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.split("\0").slice(0, -1);
}

function exampleInput(cmd: string): JsonObject {
  const args = exampleArgs(cmd);
  const index = args.indexOf("--json");
  expect(index).toBeGreaterThan(-1);
  return JSON.parse(args[index + 1]!);
}

async function bodyFixture(schema: JsonValue) {
  const compiled = await compileSpec({
    document: {
      openapi: "3.1.0",
      info: { title: "Example test", version: "1" },
      paths: {
        "/example": {
          post: {
            operationId: "example_operation",
            requestBody: { required: true, content: { "application/json": { schema } } },
            responses: { "200": { description: "OK" } },
          },
        },
      },
      components: { schemas: {} },
    },
  });
  return { op: compiled.operations[0]!, spec: compiled.bundledSpec };
}

describe("compact schema", () => {
  it("shell-quotes generated JSON without altering apostrophes or executing substitutions", async () => {
    const value = "O'Reilly $(printf injected) `printf backticks`";
    const { op, spec } = await bodyFixture({
      type: "object",
      required: ["label"],
      properties: { label: { type: "string", enum: [value] } },
    });
    const example = buildExampleCommand(op, spec);
    expect(exampleArgs(example.cmd)).toEqual([
      "call",
      "example_operation",
      "--json",
      JSON.stringify({ body: { label: value } }),
    ]);
  });

  it("shell-quotes non-word operation IDs as one literal argument", async () => {
    const { op, spec } = await bodyFixture({ type: "object" });
    op.operationId = "example $(printf injected)";
    expect(exampleArgs(buildExampleCommand(op, spec).cmd)).toEqual([
      "call",
      op.operationId,
      "--json",
      '{"body":{}}',
    ]);
  });

  it.each<{ name: string; schema: JsonObject; body: JsonValue }>([
    {
      name: "anyOf",
      schema: {
        anyOf: [
          {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
            additionalProperties: false,
          },
          { type: "null" },
        ],
      },
      body: { name: "<name>" },
    },
    {
      name: "oneOf discriminator",
      schema: {
        oneOf: [
          {
            type: "object",
            properties: { kind: { const: "first" } },
            required: ["kind"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { kind: { const: "second" } },
            required: ["kind"],
            additionalProperties: false,
          },
        ],
      },
      body: { kind: "first" },
    },
    {
      name: "array",
      schema: { type: "array", items: { type: "string" }, minItems: 1 },
      body: ["<body>"],
    },
    { name: "empty object", schema: { type: "object", additionalProperties: false }, body: {} },
    {
      name: "real value property",
      schema: { type: "object", required: ["value"], properties: { value: { type: "string" } } },
      body: { value: "<value>" },
    },
  ])("generates a valid $name body without inventing a value wrapper", async ({ schema, body }) => {
    const { op, spec } = await bodyFixture(schema);
    const input = exampleInput(buildExampleCommand(op, spec).cmd);
    expect(input.body).toEqual(body);
    const validate = new Ajv({ strict: false }).compile(schema);
    expect(validate(input.body), JSON.stringify(validate.errors)).toBe(true);
  });

  it("resolves referenced parameter enum choices for discovery and example values", async () => {
    const { op, spec } = await bodyFixture({ type: "object" });
    spec.components.schemas.Source = { type: "string", enum: ["qa", "manual"] };
    op.queryParams = [
      {
        name: "source",
        location: "query",
        required: true,
        schema: { $ref: "#/components/schemas/Source" },
      },
    ];
    expect(compactSchemaForOperation(op, spec).required.query.source).toEqual({
      type: "string",
      enum: ["qa", "manual"],
    });
    expect(exampleInput(buildExampleCommand(op, spec).cmd).query).toEqual({ source: "qa" });
  });

  it("uses top-level required union properties in current public API examples", async () => {
    const compiled = await compileSpec({ sourcePath: "spec/openapi.snapshot.json" });
    const ajv = buildAjv(compiled.bundledSpec);
    for (const [id, body] of [
      ["create_agent_response_test_route", { name: "<name>" }],
      ["create_image_generation", { prompt: "<prompt>", model_id: "gpt-image-1" }],
      [
        "create_text_to_speech_generation",
        { text: "<text>", voice: "<voice>", model_id: "eleven_flash_v2_5" },
      ],
      ["create_environment_variable", { type: "string", label: "<label>", values: {} }],
    ] as const) {
      const op = compiled.operations.find((candidate) => candidate.operationId === id)!;
      expect(op, id).toBeDefined();
      expect(exampleInput(buildExampleCommand(op, compiled.bundledSpec).cmd).body).toEqual(body);
    }
    const checked: string[] = [];
    for (const op of compiled.operations) {
      const schema = rawInputSchemaForOperation(op, compiled.bundledSpec);
      if (
        !op.requestBody?.required ||
        !schema ||
        typeof schema !== "object" ||
        Array.isArray(schema)
      )
        continue;
      if (!("anyOf" in schema || "oneOf" in schema)) continue;
      const body = exampleInput(buildExampleCommand(op, compiled.bundledSpec).cmd).body;
      const validate = getInputValidator(ajv, op);
      expect(validate, op.operationId).not.toBeNull();
      expect(validate!(body), `${op.operationId}: ${JSON.stringify(validate!.errors)}`).toBe(true);
      checked.push(op.operationId);
    }
    expect(checked).toContain("create_image_generation");
  });

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

  it("passes multipart binary fields as --file, not as JSON body values", async () => {
    const compiled = await compileSpec({ sourcePath: "spec/openapi.snapshot.json" });
    const upload = compiled.operations.find(
      (candidate) => candidate.operationId === "upload_asset",
    );
    const isolation = compiled.operations.find(
      (candidate) => candidate.operationId === "audio_isolation",
    );
    expect(upload?.requestBody?.fileFields).toEqual(["asset"]);
    expect(isolation?.requestBody?.fileFields).toEqual(["audio"]);

    expect(exampleArgs(buildExampleCommand(upload!, compiled.bundledSpec).cmd)).toEqual([
      "call",
      "upload_asset",
      "--json",
      '{"body":{"name":"<name>"}}',
      "--file",
      "asset=./path/to/asset",
    ]);
    // The body holds nothing but the file, so it drops out of --json entirely.
    expect(exampleArgs(buildExampleCommand(isolation!, compiled.bundledSpec).cmd)).toEqual([
      "call",
      "audio_isolation",
      "--json",
      "{}",
      "--file",
      "audio=./path/to/audio",
      "--out",
      "./out",
    ]);
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
});
