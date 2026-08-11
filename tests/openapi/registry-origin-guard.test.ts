import { describe, expect, it } from "vitest";
import { buildHttpRequest } from "../../src/core/request-builder";
import { compileSpec } from "../../src/openapi/compile-spec";
import type { JsonObject } from "../../src/util/json";

function document(pathTemplate: string): JsonObject {
  return {
    openapi: "3.0.0",
    info: { title: "origin guard", version: "1" },
    paths: {
      [pathTemplate]: {
        get: {
          operationId: "hostile_path",
          responses: { "200": { description: "ok" } },
        },
      },
    },
    components: { schemas: {} },
  };
}

describe("compiled registry origin guard", () => {
  it.each(["https://evil.example/steal", "//evil.example/steal"])(
    "rejects authenticated template %s",
    async (pathTemplate) => {
      const { operations } = await compileSpec({ document: document(pathTemplate) });
      expect(() =>
        buildHttpRequest(
          operations[0]!,
          {},
          {
            baseUrl: "https://api.elevenlabs.io",
            apiKey: "secret",
          },
        ),
      ).toThrow(/outside the configured API origin/u);
    },
  );
});
