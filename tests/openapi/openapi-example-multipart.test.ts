import { spawnSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAjv, getInputValidator } from "../../src/openapi/ajv";
import { buildExampleCommand } from "../../src/openapi/compact-schema";
import { compileSpec } from "../../src/openapi/compile-spec";
import type { JsonObject } from "../../src/util/json";

function exampleArgs(cmd: string): string[] {
  const result = spawnSync("sh", ["-c", `elv() { printf '%s\\0' "$@"; }; ${cmd}`], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.split("\0").slice(0, -1);
}

function exampleBody(cmd: string): JsonObject {
  const args = exampleArgs(cmd);
  const jsonIndex = args.indexOf("--json");
  expect(jsonIndex).toBeGreaterThan(-1);
  const input = JSON.parse(args[jsonIndex + 1]!) as { body: JsonObject };
  return input.body;
}

describe("multipart operation examples", () => {
  let compiled: Awaited<ReturnType<typeof compileSpec>>;

  beforeAll(async () => {
    compiled = await compileSpec({ sourcePath: "spec/openapi.snapshot.json" });
  });

  it("selects the STT file branch when no media source is structurally required", () => {
    const operation = compiled.operations.find(
      ({ operationId }) => operationId === "speech_to_text",
    );
    expect(operation).toBeDefined();

    expect(exampleArgs(buildExampleCommand(operation!, compiled.bundledSpec).cmd)).toEqual([
      "call",
      "speech_to_text",
      "--json",
      '{"body":{"model_id":"<model_id>"}}',
      "--file",
      "file=./path/to/file",
    ]);
  });

  it.each([
    ["create_image_generation", { prompt: "<prompt>", model_id: "gpt-image-1" }],
    ["create_environment_variable", { type: "string", label: "<label>", values: {} }],
  ] as const)("keeps the existing %s union example valid", (operationId, expectedBody) => {
    const operation = compiled.operations.find(
      (candidate) => candidate.operationId === operationId,
    );
    expect(operation).toBeDefined();
    const body = exampleBody(buildExampleCommand(operation!, compiled.bundledSpec).cmd);
    expect(body).toEqual(expectedBody);

    const validate = getInputValidator(buildAjv(compiled.bundledSpec), operation!);
    expect(validate).not.toBeNull();
    expect(validate!(body), JSON.stringify(validate!.errors)).toBe(true);
  });
});
