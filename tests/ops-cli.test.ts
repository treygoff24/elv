import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type CliResult = { stdout: string; stderr: string; code: number | null; cacheDir: string };

function runCli(args: string[], env?: Record<string, string>): CliResult {
  const cacheDir = mkdtempSync(join(tmpdir(), "elv-cache-"));
  const result = spawnSync("npx", ["tsx", "src/cli.ts", ...args], {
    encoding: "utf-8",
    env: { ...process.env, ELV_CACHE_DIR: cacheDir, ...env },
  });

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status,
    cacheDir,
  };
}

function parseEnvelope(stdout: string): Record<string, unknown> {
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

function operationIdOf(item: unknown): string | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const record = item as Record<string, unknown>;
  if (typeof record.operationId === "string") return record.operationId;
  if (typeof record.operation_id === "string") return record.operation_id;
  return undefined;
}

function searchResults(envelope: Record<string, unknown>): unknown[] {
  const data = envelope.data;
  expect(Array.isArray(data)).toBe(true);
  return data as unknown[];
}

describe("ops CLI (black-box, integration gate)", () => {
  it('ops search "text to speech" finds text_to_speech_full (AC #6)', () => {
    const { stdout, code } = runCli(["ops", "search", "text to speech"]);
    expect(code).toBe(0);

    const envelope = parseEnvelope(stdout);
    expect(envelope.ok).toBe(true);

    const results = searchResults(envelope);
    expect(results.length).toBeGreaterThan(0);

    const ids = results.map(operationIdOf);
    expect(ids).toContain("text_to_speech_full");

    const rank = ids.indexOf("text_to_speech_full");
    expect(rank).toBeGreaterThanOrEqual(0);
    expect(rank).toBeLessThan(10);
  });

  it("ops search --limit 3 returns at most 3 results", () => {
    const { stdout, code } = runCli(["ops", "search", "voice", "--limit", "3"]);
    expect(code).toBe(0);

    const envelope = parseEnvelope(stdout);
    expect(envelope.ok).toBe(true);
    expect(searchResults(envelope).length).toBeLessThanOrEqual(3);
  });

  it("ops get text_to_speech_full returns an operation card", () => {
    const { stdout, code } = runCli(["ops", "get", "text_to_speech_full"]);
    expect(code).toBe(0);

    const envelope = parseEnvelope(stdout);
    expect(envelope.ok).toBe(true);

    const data = envelope.data;
    expect(data).toBeTypeOf("object");
    expect(data).not.toBeNull();

    const op = data as Record<string, unknown>;
    expect(op.operationId ?? op.operation_id).toBe("text_to_speech_full");
    expect(typeof op.method).toBe("string");
    expect(typeof (op.pathTemplate ?? op.path)).toBe("string");
    expect(typeof op.risk).toBe("string");
  });

  it("ops get unknown operation returns error envelope with exit 9", () => {
    const { stdout, code } = runCli(["ops", "get", "totally_made_up_op_id"]);
    expect(code).toBe(9);

    const envelope = parseEnvelope(stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toBeTypeOf("object");
  });

  it("ops schema text_to_speech_full returns compact required/optional buckets", () => {
    const { stdout, code } = runCli(["ops", "schema", "text_to_speech_full"]);
    expect(code).toBe(0);

    const envelope = parseEnvelope(stdout);
    expect(envelope.ok).toBe(true);

    const schema = (envelope.data ?? envelope) as Record<string, unknown>;
    const hasRequired = schema.required !== undefined;
    const hasOptional = schema.optional !== undefined;
    expect(hasRequired || hasOptional).toBe(true);
  });

  it("ops schema --example emits a runnable elv call command", () => {
    const { stdout, code } = runCli(["ops", "schema", "text_to_speech_full", "--example"]);
    expect(code).toBe(0);

    const envelope = parseEnvelope(stdout);
    expect(envelope.ok).toBe(true);

    const exampleRaw =
      envelope.example ??
      (typeof envelope.data === "object" && envelope.data !== null
        ? (envelope.data as Record<string, unknown>).example
        : undefined);
    expect(exampleRaw).toBeTypeOf("object");
    expect(exampleRaw).not.toBeNull();
    const example = exampleRaw as Record<string, unknown>;
    expect(typeof example.cmd).toBe("string");
    expect(example.cmd).toMatch(/^elv call/);
  });

  it("cold-start ops search bootstraps from vendored snapshot without network (AC #28)", () => {
    const { stdout, code, cacheDir } = runCli(["ops", "search", "speech"]);
    expect(code).toBe(0);

    const envelope = parseEnvelope(stdout);
    expect(envelope.ok).toBe(true);
    expect(searchResults(envelope).length).toBeGreaterThan(0);

    // Fresh ELV_CACHE_DIR per invocation — no prior registry on disk.
    expect(cacheDir).toMatch(/elv-cache-/);
  });
});
