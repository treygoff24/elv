import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { arrayValue, parseEnvelope, recordValue, type CliResult } from "../helpers/cli-result";

function hasAnsiEscape(text: string): boolean {
  return text.includes("\u001b");
}

function runCli(args: string[], env?: Record<string, string>): CliResult {
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

describe("CLI JSON output contract", () => {
  it("config get emits one success envelope with v=1 and ok=true", () => {
    const { stdout, stderr, code } = runCli(["config", "get"]);

    expect(code).toBe(0);
    expect(hasAnsiEscape(stdout)).toBe(false);
    expect(hasAnsiEscape(stderr)).toBe(false);

    const envelope = parseEnvelope(stdout);
    expect(envelope.v).toBe(1);
    expect(envelope.ok).toBe(true);
  });

  it("unknown operation emits error envelope and documented nonzero exit", () => {
    const { stdout, code } = runCli(["call", "some_unknown_op"]);

    expect(code).not.toBe(0);
    expect([8, 9]).toContain(code);

    const envelope = parseEnvelope(stdout);
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

  it("reports malformed local config as a config error envelope", () => {
    const dir = mkdtempSync(join(tmpdir(), "elv-bad-config-"));
    try {
      const configPath = join(dir, "config.json");
      writeFileSync(configPath, "{broken");
      const { stdout, code } = runCli(["config", "get"], { ELV_CONFIG: configPath });

      expect(code).toBe(2);
      const envelope = parseEnvelope(stdout);
      expect(envelope.ok).toBe(false);
      expect(envelope.error).toMatchObject({
        type: "config_error",
        code: "config_json_invalid",
      });
      expect(String((envelope.error as Record<string, unknown>).message)).toContain(configPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("success stdout is a single JSON object with no leading or trailing prose", () => {
    const { stdout } = runCli(["config", "get"]);
    parseEnvelope(stdout);
  });

  it("bare elv emits a success help envelope listing commands with descriptions", () => {
    const { stdout, code } = runCli([]);
    expect(code).toBe(0);
    const envelope = parseEnvelope(stdout);
    expect(envelope.ok).toBe(true);
    const data = envelope.data as Record<string, unknown>;
    expect(data.command).toBe("elv");
    expect((data.description as string).length).toBeGreaterThan(0);
    const commands = data.commands as Array<{ name: string; description: string }>;
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((c) => typeof c.name === "string" && c.description.length > 0)).toBe(
      true,
    );
    expect(commands.some((c) => c.name === "tts")).toBe(true);
  });

  it("classifies a missing required flag as validation_error (exit 2), not internal_error", () => {
    const { stdout, code } = runCli(["tts"]);
    expect(code).toBe(2);
    const envelope = parseEnvelope(stdout);
    expect(envelope.ok).toBe(false);
    const error = envelope.error as Record<string, unknown>;
    expect(error.code).toBe("validation_error");
    expect(String(error.message)).toMatch(/--text or --text-file/);
  });

  it("voice-change with no voice also classifies as validation_error (exit 2)", () => {
    const { stdout, code } = runCli(["voice-change", "--file", "/tmp/nope.mp3"]);
    expect(code).toBe(2);
    const envelope = parseEnvelope(stdout);
    expect(envelope.ok).toBe(false);
    expect((envelope.error as Record<string, unknown>).code).toBe("validation_error");
  });

  it("nested alias validation reports the full command path", () => {
    const { stdout, code } = runCli(["agents", "create"]);
    expect(code).toBe(2);
    const envelope = parseEnvelope(stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.cmd).toBe("elv agents create");
  });

  it("tts validates local text input before resolving --voice by network lookup", () => {
    const { stdout, code } = runCli(["tts", "--voice", "Rachel"]);
    expect(code).toBe(2);
    const envelope = parseEnvelope(stdout);
    expect(envelope.ok).toBe(false);
    const error = envelope.error as Record<string, unknown>;
    expect(error.code).toBe("validation_error");
    expect(String(error.message)).toContain("--text or --text-file");
  });

  it("rejects invalid --max-credits consistently on call, http, and alias paths", () => {
    for (const args of [
      ["config", "get", "--max-credits", "not-a-number"],
      ["call", "get_voices", "--max-credits", "not-a-number", "--dry-run"],
      ["http", "GET", "/v1/voices", "--max-credits", "not-a-number", "--dry-run"],
      [
        "tts",
        "--voice-id",
        "voice",
        "--text",
        "hello",
        "--max-credits",
        "not-a-number",
        "--dry-run",
      ],
    ]) {
      const { stdout, code } = runCli(args);
      expect(code, args.join(" ")).toBe(2);
      const envelope = parseEnvelope(stdout);
      expect(envelope.ok).toBe(false);
      expect((envelope.error as Record<string, unknown>).code).toBe("validation_error");
      expect(String((envelope.error as Record<string, unknown>).message)).toContain(
        "Expected number",
      );
    }
  }, 15_000);

  it("voices get accepts the voice id as a positional argument", () => {
    const { stdout, code } = runCli(["voices", "get", "POSITIONAL_ID", "--dry-run"]);
    expect(code).toBe(0);
    const envelope = parseEnvelope(stdout);
    expect(envelope.ok).toBe(true);
    const request = (envelope.data as Record<string, unknown>).request as Record<string, unknown>;
    const input = request.input as { path?: { voice_id?: string } };
    expect(input.path?.voice_id).toBe("POSITIONAL_ID");
  });

  it("voices get with no id reports a validation error mentioning the positional form", () => {
    const { stdout, code } = runCli(["voices", "get"]);
    expect(code).toBe(2);
    const envelope = parseEnvelope(stdout);
    expect(envelope.ok).toBe(false);
    expect(String((envelope.error as Record<string, unknown>).message)).toMatch(/positional/);
  });

  it("bare parent commands emit help envelopes with subcommands", () => {
    for (const command of ["ops", "config", "spec"]) {
      const { stdout, code } = runCli([command]);
      expect(code).toBe(0);
      const envelope = parseEnvelope(stdout);
      expect(envelope.ok).toBe(true);
      const data = envelope.data as Record<string, unknown>;
      expect(data.command).toBe(command);
      expect(Array.isArray(data.subcommands)).toBe(true);
      expect((data.subcommands as string[]).length).toBeGreaterThan(0);
    }
  }, 10_000);

  it("subcommand --help emits per-command metadata instead of the global list", () => {
    const { stdout: ttsStdout, code: ttsCode } = runCli(["tts", "--help"]);
    expect(ttsCode).toBe(0);
    const ttsEnvelope = parseEnvelope(ttsStdout);
    expect(ttsEnvelope.ok).toBe(true);
    const ttsData = ttsEnvelope.data as Record<string, unknown>;
    expect(ttsData.command).toBe("tts");
    expect(ttsData.commands).toBeUndefined();
    const ttsOptions = ttsData.options as Array<{ flags: string; description?: string }>;
    expect(ttsOptions.some((o) => o.flags.includes("--voice-id"))).toBe(true);
    expect(ttsOptions.some((o) => o.flags.includes("--text"))).toBe(true);
    expect(ttsOptions.some((o) => o.flags.includes("--json <json>"))).toBe(false);
    for (const option of ttsOptions) {
      expect(option.description?.trim().length).toBeGreaterThan(0);
    }

    const { stdout: viewStdout, code: viewCode } = runCli(["view", "--help"]);
    expect(viewCode).toBe(0);
    const viewEnvelope = parseEnvelope(viewStdout);
    const viewData = viewEnvelope.data as Record<string, unknown>;
    expect(viewData.command).toBe("view");
    expect(viewData).not.toEqual(ttsData);
  });
});

describe("did-you-mean suggestions", () => {
  it("suggests the nearest command for a mistyped verb", () => {
    const { stdout, code } = runCli(["tss"]);
    expect(code).toBe(9);
    const envelope = parseEnvelope(stdout);
    expect(envelope.ok).toBe(false);
    const hints = arrayValue(envelope.hints, "hints").map((h) => recordValue(h));
    expect(hints[0]?.cmd).toBe("elv tts");
    expect(String(hints[0]?.why)).toContain("Did you mean");
  });

  it("suggests the nearest flag and rebuilds the corrected command", () => {
    const { stdout, code } = runCli(["tts", "--txt", "hello", "--voice-id", "x"]);
    expect(code).toBe(2);
    const hints = arrayValue(parseEnvelope(stdout).hints, "hints").map((h) => recordValue(h));
    expect(hints[0]?.cmd).toBe("elv tts --text hello --voice-id x");
  });

  it("emits no suggestion when nothing is close", () => {
    const { stdout, code } = runCli(["zzzzzzzz"]);
    expect(code).toBe(9);
    expect(parseEnvelope(stdout).hints).toBeUndefined();
  });

  it("suggests nearest operation ids for an unknown call id", () => {
    const { stdout } = runCli(["call", "text_to_speech"]);
    const hints = arrayValue(parseEnvelope(stdout).hints, "hints").map((h) => recordValue(h));
    expect(hints.some((h) => h.cmd === "elv call text_to_speech_full")).toBe(true);
  });

  it("suggests the nearest subcommand for a mistyped parent subcommand", () => {
    const { stdout, code } = runCli(["ops", "serch", "text to speech"]);
    expect(code).toBe(2);
    const hints = arrayValue(parseEnvelope(stdout).hints, "hints").map((h) => recordValue(h));
    expect(hints[0]?.cmd).toBe("elv ops search text to speech");
  });

  it("does not suggest for a genuine excess argument on a leaf command", () => {
    const { stdout, code } = runCli(["ops", "get", "some_op", "extra_arg"]);
    expect(code).toBe(2);
    expect(parseEnvelope(stdout).hints).toBeUndefined();
  });

  it("names --dry-run when a destructive op needs confirmation", () => {
    const { stdout, code } = runCli(["call", "delete_voice", "--path", "voice_id=x"], {
      ELEVENLABS_API_KEY: "test_key_CANARY",
    });
    expect(code).toBe(4);
    const hints = arrayValue(parseEnvelope(stdout).hints, "hints").map((h) => recordValue(h));
    expect(hints.some((h) => String(h.cmd).endsWith("--dry-run"))).toBe(true);
  });
});
