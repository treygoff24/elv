import { spawn } from "node:child_process";
import { expect } from "vitest";
import type { JsonObject, JsonValue } from "../../src/util/json";

export interface CliResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export function runCli(args: string[], env?: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      env: { ...process.env, ...env },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code: number | null) => resolve({ stdout, stderr, code }));
  });
}

export function parseEnvelope(stdout: string): JsonObject {
  const trimmed = stdout.trim();
  expect(trimmed.length).toBeGreaterThan(0);
  expect(trimmed.startsWith("{")).toBe(true);
  expect(trimmed.endsWith("}")).toBe(true);

  const parsed: unknown = JSON.parse(trimmed);
  return recordValue(parsed, "stdout envelope");
}

export function errorRecord(envelope: JsonObject): JsonObject {
  return recordValue(envelope.error, "error");
}

export function filesArray(envelope: JsonObject): JsonObject[] {
  return arrayValue(envelope.files, "files").map((file) => recordValue(file, "file"));
}

export function arrayValue(value: unknown, label = "value"): JsonValue[] {
  if (!Array.isArray(value)) {
    expect(Array.isArray(value)).toBe(true);
    throw new Error(`${label} must be an array`);
  }
  return value as JsonValue[];
}

export function recordValue(value: unknown, label = "value"): JsonObject {
  if (!isRecordValue(value)) {
    expect(value).toBeTypeOf("object");
    expect(value).not.toBeNull();
    expect(Array.isArray(value)).toBe(false);
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function isRecordValue(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function assertNoKeyLeak(stdout: string, stderr: string, apiKey = "test_key_CANARY"): void {
  expect(stdout).not.toContain(apiKey);
  expect(stderr).not.toContain(apiKey);
}
