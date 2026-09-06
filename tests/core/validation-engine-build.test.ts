import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runOperation, validateParameters } from "../../src/core/client";
import type { AgentInput } from "../../src/core/types";
import type { OperationCard } from "../../src/openapi/types";
import type { JsonValue } from "../../src/util/json";
import * as registry from "../../src/openapi/registry";

// Building AJV over the bundled spec costs about 20 ms; most invocations
// validate no parameter and no body, so the build must wait for a real use.
const engine = vi.hoisted(() => ({ builds: 0 }));

vi.mock("../../src/openapi/ajv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/openapi/ajv")>();
  return {
    ...actual,
    buildAjv: (...args: Parameters<typeof actual.buildAjv>) => {
      engine.builds += 1;
      return actual.buildAjv(...args);
    },
  };
});

function operation(schema: JsonValue | undefined): OperationCard {
  return {
    operationId: "engine_build_test",
    method: "GET",
    pathTemplate: "/test",
    group: [],
    tags: [],
    pathParams: [],
    queryParams:
      schema === undefined
        ? []
        : [{ name: "selector", location: "query", required: false, schema }],
    headerParams: [],
    responses: [],
    risk: "read",
    returnsBinary: false,
    returnsJson: true,
    streamKind: "none",
    deprecated: false,
    examples: [],
  };
}

let cacheDir: string;

beforeEach(() => {
  engine.builds = 0;
  cacheDir = mkdtempSync(join(tmpdir(), "elv-engine-build-"));
  vi.stubEnv("ELV_CACHE_DIR", cacheDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("validation engine construction", () => {
  it("builds nothing when no supplied parameter needs validating", async () => {
    const op = operation({ type: "string" });

    expect(await validateParameters(op, {}, undefined)).toBeNull();

    expect(engine.builds).toBe(0);
  });

  it("builds one shared instance when a parameter is supplied", async () => {
    const op = operation({ type: "string" });
    const input: AgentInput = { query: { selector: "value" } };

    expect(await validateParameters(op, input, undefined)).toBeNull();

    expect(engine.builds).toBe(1);
  });

  it("builds nothing for an operation with no parameters and no request body", async () => {
    const op = operation(undefined);
    vi.spyOn(registry, "loadRegistry").mockResolvedValue(new Map([[op.operationId, op]]));

    const env = await runOperation(op.operationId, {}, { dryRun: true });

    expect(env.ok).toBe(true);
    expect(engine.builds).toBe(0);
  });
});
