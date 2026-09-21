import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { arrayValue, parseEnvelope, recordValue, runCli } from "../helpers/cli-result";

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
        expect(executed.code, command).toBe(0);
        const hintEnvelope = parseEnvelope(executed.stdout);
        expect(hintEnvelope.ok, command).toBe(true);
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

  it.each([
    {
      name: "body-only alias",
      args: ["workspace", "service-accounts", "create", "--name", "Bot"],
      operationId: "create_service_account",
      input: { body: { name: "Bot" } },
    },
    {
      name: "path-plus-body alias",
      args: ["voices", "replicate", "--voice-id", "V1", "--target-workspace-id", "W1"],
      operationId: "replicate_voice_to_isolated_environment",
      input: { path: { voice_id: "V1" }, body: { target_workspace_id: "W1" } },
    },
  ])("emits a runnable canonical confirmation replay for $name", async (testCase) => {
    const blocked = await runCli(testCase.args, env);
    expect(blocked.code).toBe(4);
    const envelope = parseEnvelope(blocked.stdout);
    const hints = arrayValue(envelope.hints).map((hint) => recordValue(hint));
    expect(hints).toEqual([
      {
        cmd: `elv call ${testCase.operationId} --json '${JSON.stringify(testCase.input)}' --dry-run`,
        why: "Preview the normalized request without calling the API or mutating anything.",
      },
    ]);
    const replay = await runHint(String(hints[0]!.cmd), env);
    expect(replay.code).toBe(0);
    expect(parseEnvelope(replay.stdout).ok).toBe(true);
  });

  it("does not replay a ConvAI secret body", async () => {
    const secret = "PLAIN_VALUE_SECRET_CANARY";
    const result = await runCli(
      [
        "call",
        "create_secret_route",
        "--json",
        JSON.stringify({ body: { type: "new", name: "probe", value: secret } }),
      ],
      env,
    );
    expect(result.code).toBe(4);
    const envelope = parseEnvelope(result.stdout);
    expect(JSON.stringify(envelope.hints)).not.toContain(secret);
    expect(envelope.hints).toEqual([
      {
        cmd: "elv ops schema create_secret_route --example",
        why: "Build a safe preview from the operation schema; the current input cannot be replayed safely.",
      },
    ]);
  });

  it("quotes raw HTTP query strings in output-target recovery commands", async () => {
    const blocker = join(root, "not-a-directory");
    writeFileSync(blocker, "occupied");
    const result = await runCli(
      [
        "http",
        "GET",
        "/probe/provider?foo=bar&baz=1",
        "--out",
        join(blocker, "response.json"),
        "--dry-run",
      ],
      env,
    );
    expect(result.code).toBe(2);
    const envelope = parseEnvelope(result.stdout);
    const hint = recordValue(arrayValue(envelope.hints)[0]);
    expect(hint.cmd).toBe("elv http GET '/probe/provider?foo=bar&baz=1' --out ./output --dry-run");
    const replay = await runHint(String(hint.cmd), env);
    expect(replay.code).toBe(0);
    expect(parseEnvelope(replay.stdout).ok).toBe(true);
  });
});

function runHint(
  command: string,
  env: Record<string, string>,
): Promise<{ stdout: string; code: number | null }> {
  const cli = `${process.execPath} --import tsx src/cli.ts`;
  const runnable = command.replace(/^elv\b/u, cli);
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", runnable], { env: { ...process.env, ...env } });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, code }));
  });
}
