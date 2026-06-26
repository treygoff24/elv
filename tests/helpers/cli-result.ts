import { spawn } from "node:child_process";
import { expect } from "vitest";

export interface CliResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export function runCli(args: string[], env?: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", "src/cli.ts", ...args], {
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

export function parseEnvelope(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  expect(trimmed.length).toBeGreaterThan(0);
  expect(trimmed.startsWith("{")).toBe(true);
  expect(trimmed.endsWith("}")).toBe(true);

  const parsed: unknown = JSON.parse(trimmed);
  expect(parsed).toBeTypeOf("object");
  expect(parsed).not.toBeNull();
  expect(Array.isArray(parsed)).toBe(false);

  return parsed as Record<string, unknown>;
}

export function errorRecord(envelope: Record<string, unknown>): Record<string, unknown> {
  const error = envelope.error;
  expect(error).toBeTypeOf("object");
  expect(error).not.toBeNull();
  return error as Record<string, unknown>;
}

export function filesArray(envelope: Record<string, unknown>): Record<string, unknown>[] {
  const files = envelope.files;
  expect(Array.isArray(files)).toBe(true);
  return files as Record<string, unknown>[];
}

export function assertNoKeyLeak(stdout: string, stderr: string, apiKey = "test_key_CANARY"): void {
  expect(stdout).not.toContain(apiKey);
  expect(stderr).not.toContain(apiKey);
}
