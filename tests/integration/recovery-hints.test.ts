import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { arrayValue, errorRecord, parseEnvelope, recordValue, runCli } from "../helpers/cli-result";

interface FailureCase {
  name: string;
  args: string[];
  exit: number;
}

describe("failure recovery hints", () => {
  let server: Server;
  let root: string;
  let configPath: string;
  let env: Record<string, string>;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "elv-recovery-hints-"));
    server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (path === "/v1/user/subscription") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ character_count: 1, character_limit: 100 }));
        return;
      }
      const probe = path.match(/^\/probe\/(auth|credits|transient|provider|missing)$/u)?.[1];
      const fixtures = {
        auth: [401, "invalid_api_key"],
        credits: [400, "quota_exceeded"],
        transient: [503, "service_unavailable"],
        provider: [418, "provider_probe_error"],
        missing: [404, "not_found"],
      } as const;
      const [status, code] = probe ? fixtures[probe as keyof typeof fixtures] : [200, "ok"];
      res.writeHead(status, {
        "content-type": "application/json",
        ...(status === 503 ? { "retry-after": "0" } : {}),
      });
      res.end(JSON.stringify({ detail: { status: code, message: `probe ${code}` } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP listener");
    configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        default_profile: "probe",
        profiles: {
          probe: {
            base_url: `http://127.0.0.1:${address.port}`,
            api_key_env: "ELV_PROBE_KEY",
            output_dir: join(root, "output"),
          },
        },
      }),
    );
    env = {
      ELV_CONFIG: configPath,
      ELV_CACHE_DIR: join(root, "cache"),
      ELV_PROBE_KEY: "test_key_CANARY",
    };
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(root, { recursive: true, force: true });
  });

  const cases: FailureCase[] = [
    {
      name: "validation",
      args: ["call", "text_to_speech_full", "--dry-run"],
      exit: 2,
    },
    { name: "authentication", args: ["http", "GET", "/probe/auth"], exit: 3 },
    {
      name: "confirmation",
      args: ["call", "delete_voice", "--path", "voice_id=voice_1"],
      exit: 4,
    },
    {
      name: "budget",
      args: ["tts", "--voice-id", "voice_1", "--text", "hello", "--max-credits", "0"],
      exit: 5,
    },
    { name: "credits", args: ["http", "GET", "/probe/credits"], exit: 6 },
    { name: "transient", args: ["http", "GET", "/probe/transient"], exit: 7 },
    { name: "provider", args: ["http", "GET", "/probe/provider"], exit: 8 },
    { name: "not found", args: ["http", "GET", "/probe/missing"], exit: 9 },
  ];

  it.each(cases)(
    "gives exit $exit ($name) at least one runnable recovery hint",
    async (testCase) => {
      const result = await runCli(testCase.args, env);
      expect(result.code).toBe(testCase.exit);
      const envelope = parseEnvelope(result.stdout);
      const hints = arrayValue(envelope.hints, "hints").map((hint) => recordValue(hint));
      expect(hints.length).toBeGreaterThan(0);
      expect(JSON.stringify(hints)).not.toMatch(/elv ops (?:get|schema) http/u);

      for (const hint of hints) {
        const command = String(hint.cmd);
        const executed = await runHint(command, env);
        expect(executed.stdout.trim(), command).not.toBe("");
        const hintEnvelope = parseEnvelope(executed.stdout);
        if (hintEnvelope.ok === false) {
          const error = errorRecord(hintEnvelope);
          expect(error.code, command).not.toBe("unknown_command");
          expect(String(error.message), command).not.toMatch(/unknown option/iu);
        }
      }
    },
  );

  it("uses the configured profile key source and preserves destructive path input", async () => {
    const auth = parseEnvelope((await runCli(["http", "GET", "/probe/auth"], env)).stdout);
    expect(JSON.stringify(auth.hints)).toContain("api_key_env");
    expect(JSON.stringify(auth.hints)).not.toContain("ELEVENLABS_API_KEY");

    const confirmation = parseEnvelope(
      (await runCli(["call", "delete_voice", "--path", "voice_id=voice_1"], env)).stdout,
    );
    const hint = recordValue(arrayValue(confirmation.hints)[0]);
    expect(hint.cmd).toContain("voice_id");
    expect(hint.cmd).toContain("voice_1");
    expect(hint.cmd).toContain("--dry-run");
  });

  it("falls back to top-level help for an unknown command", async () => {
    const result = await runCli(["does-not-exist"], env);
    expect(result.code).toBe(9);
    const envelope = parseEnvelope(result.stdout);
    const commands = arrayValue(envelope.hints).map((hint) => String(recordValue(hint).cmd));
    expect(commands).toContain("elv --help");
  });
});

function runHint(command: string, env: Record<string, string>): Promise<{ stdout: string }> {
  const cli = `${process.execPath} --import tsx src/cli.ts`;
  const runnable = command.replace(/^elv\b/u, cli);
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", runnable], { env: { ...process.env, ...env } });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", () => resolve({ stdout }));
  });
}
