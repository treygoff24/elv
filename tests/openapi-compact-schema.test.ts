import { describe, expect, it } from "vitest";
import { compileSpec } from "../src/openapi/compile-spec";
import {
  buildExampleCommand,
  compactSchemaForOperation,
  rawInputSchemaForOperation,
} from "../src/openapi/compact-schema";

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
});
