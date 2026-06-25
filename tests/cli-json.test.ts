import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function hasAnsiEscape(text: string): boolean {
  return text.includes("\u001b");
}

export function runCli(
  args: string[],
  env?: Record<string, string>,
): { stdout: string; stderr: string; code: number | null } {
  const result = spawnSync("npx", ["tsx", "src/cli.ts", ...args], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status,
  };
}

function parseStdoutEnvelope(stdout: string): Record<string, unknown> {
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

describe("CLI JSON output contract", () => {
  it("config get emits one success envelope with v=1 and ok=true", () => {
    const { stdout, stderr, code } = runCli(["config", "get"]);

    expect(code).toBe(0);
    expect(hasAnsiEscape(stdout)).toBe(false);
    expect(hasAnsiEscape(stderr)).toBe(false);

    const envelope = parseStdoutEnvelope(stdout);
    expect(envelope.v).toBe(1);
    expect(envelope.ok).toBe(true);
  });

  it("unknown operation emits error envelope and documented nonzero exit", () => {
    const { stdout, code } = runCli(["call", "some_unknown_op"]);

    expect(code).not.toBe(0);
    expect([8, 9]).toContain(code);

    const envelope = parseStdoutEnvelope(stdout);
    expect(envelope.v).toBe(1);
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toBeTypeOf("object");
    expect(envelope.error).not.toBeNull();
  });

  it("redacts ELEVENLABS_API_KEY from stdout and stderr", () => {
    const leak = "sk_test_LEAK_CANARY_123";
    const { stdout, stderr } = runCli(["config", "get"], {
      ELEVENLABS_API_KEY: leak,
    });

    expect(stdout).not.toContain(leak);
    expect(stderr).not.toContain(leak);
  });

  it("success stdout is a single JSON object with no leading or trailing prose", () => {
    const { stdout } = runCli(["config", "get"]);
    parseStdoutEnvelope(stdout);
  });
});
