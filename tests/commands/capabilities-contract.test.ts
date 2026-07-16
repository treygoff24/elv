import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleCapabilities } from "../../src/commands/capabilities";

function record(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  expect(Array.isArray(value)).toBe(true);
  return value as unknown[];
}

describe("capabilities machine contract", () => {
  const previousCache = process.env.ELV_CACHE_DIR;

  beforeEach(() => {
    process.env.ELV_CACHE_DIR = mkdtempSync(join(tmpdir(), "elv-capabilities-"));
  });

  afterEach(() => {
    if (previousCache === undefined) delete process.env.ELV_CACHE_DIR;
    else process.env.ELV_CACHE_DIR = previousCache;
  });

  it("returns the bounded top-level schema with stable sorted inventories", async () => {
    const result = await handleCapabilities({ version: "9.8.7" });
    expect(result.exitCode).toBe(0);
    expect(result.env.ok).toBe(true);

    const data = record(result.env.ok ? result.env.data : undefined);
    expect(Object.keys(data)).toEqual([
      "cli",
      "spec",
      "command_families",
      "service_groups",
      "alias_families",
      "websockets",
      "protocol",
      "configuration",
      "safety",
      "next",
    ]);
    expect(record(data.cli)).toEqual({ name: "elv", version: "9.8.7", envelope_version: 1 });
    expect(record(data.spec)).toMatchObject({
      source: expect.any(String),
      sha256: expect.any(String),
      callable_operations: expect.any(Number),
      skipped_operations: expect.any(Number),
    });

    const groups = array(data.service_groups).map((entry) => String(record(entry).name));
    expect(groups).toEqual([...groups].sort());
    const aliases = array(data.alias_families).map((entry) => String(record(entry).name));
    expect(aliases).toEqual([...aliases].sort());
    const websockets = array(data.websockets).map((entry) => String(record(entry).name));
    expect(websockets).toEqual([...websockets].sort());

    expect(record(data.protocol)).toMatchObject({
      stdout: "exactly_one_json_envelope",
      envelope_version: 1,
    });
    expect(record(data.safety)).toMatchObject({
      confirmation_flag: "--yes",
      budget_flag: "--max-credits",
    });
    expect(array(data.next)).toHaveLength(4);
  });
});
