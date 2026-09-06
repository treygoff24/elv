import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSpeechEngineServe } from "../../src/commands/speech-engine";
import { parseEnvelope, runCli } from "../helpers/cli-result";

describe("Speech Engine command preflight and lifecycle", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "elv-speech-engine-cli-"));
    vi.stubEnv("ELV_MAX_CREDITS", "");
    vi.stubEnv("ELEVENLABS_API_KEY", "local-test-verification-key");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("dry-run and budget/confirmation gates never bind the requested port or spawn a handler", async () => {
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("No test port");
    const script = join(dir, "marker.mjs");
    const marker = join(dir, "spawned");
    writeFileSync(
      script,
      `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(marker)},"spawned");`,
    );
    const flags = {
      handlerJson: JSON.stringify([process.execPath, script]),
      port: String(address.port),
      readyFile: join(dir, "ready.json"),
    };
    try {
      const preview = await runSpeechEngineServe(flags, { dryRun: true, maxCredits: 10 });
      expect(preview.exitCode).toBe(0);
      expect(preview.env).toMatchObject({
        data: { dry_run: true, would_require_yes: true, would_exceed_budget: true },
      });
      expect((await runSpeechEngineServe(flags, { yes: true, maxCredits: 10 })).exitCode).toBe(5);
      expect((await runSpeechEngineServe(flags, {})).exitCode).toBe(4);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(flags.readyFile)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });

  it.each([
    { handlerJson: "[]" },
    { handlerJson: '"node handler.mjs"' },
    { handlerJson: '["node",3]' },
    { handlerJson: '["node"]', port: "-1" },
    { handlerJson: '["node"]', host: "not-a-listen-address" },
    { handlerJson: '["node"]', timeoutMs: "0" },
    { handlerJson: '["node"]', handlerEnv: ["NOT=AN_ENV_NAME"] },
  ])("rejects malformed options before listening: %j", async (flags) => {
    expect((await runSpeechEngineServe(flags, { dryRun: true })).exitCode).toBe(2);
  });

  it("refuses serving without a verification key", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    const result = await runSpeechEngineServe(
      { handlerJson: '["node"]', port: "0" },
      { yes: true },
    );
    expect(result.exitCode).toBe(3);
  });

  it("CLI writes private readiness and exactly one final envelope after server lifetime expires", async () => {
    const ready = join(dir, "ready.json");
    const result = await runCli(
      [
        "speech-engine",
        "serve",
        "--handler-json",
        '["node"]',
        "--port",
        "0",
        "--timeout-ms",
        "50",
        "--ready-file",
        ready,
        "--yes",
      ],
      { ELEVENLABS_API_KEY: "local-test-verification-key", ELV_MAX_CREDITS: "" },
    );
    expect(result.code, result.stdout).toBe(0);
    expect(parseEnvelope(result.stdout)).toMatchObject({
      cmd: "elv speech-engine serve",
      data: { reason: "timeout", connections_accepted: 0 },
    });
    const readiness = JSON.parse(readFileSync(ready, "utf8"));
    expect(readiness).toMatchObject({ event: "listening", host: "127.0.0.1", path: "/ws" });
    expect(readiness.port).toBeGreaterThan(0);
    expect(statSync(ready).mode & 0o777).toBe(0o600);
    expect(result.stderr).not.toContain("local-test-verification-key");
    expect(result.stdout).not.toContain("local-test-verification-key");
  });

  it("SIGTERM shuts down without stray stdout or a second final envelope", async () => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "speech-engine",
        "serve",
        "--handler-json",
        '["node"]',
        "--port",
        "0",
        "--yes",
      ],
      {
        env: {
          ...process.env,
          ELEVENLABS_API_KEY: "local-test-verification-key",
          ELV_MAX_CREDITS: "",
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    const exit = new Promise<number | null>((resolve) => child.once("close", resolve));
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", () =>
          reject(new Error(`CLI exited before readiness: ${stdout} ${stderr}`)),
        );
        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
          if (stderr.includes('"event":"listening"')) resolve();
        });
      });
      child.kill("SIGTERM");
      expect(await exit).toBe(0);
      expect(parseEnvelope(stdout)).toMatchObject({ data: { reason: "signal" } });
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("does not overwrite an existing readiness file", async () => {
    const ready = join(dir, "ready.json");
    writeFileSync(ready, "keep");
    const result = await runSpeechEngineServe(
      { handlerJson: '["node"]', port: "0", readyFile: ready },
      { yes: true },
    );
    expect(result.exitCode).toBe(2);
    expect(readFileSync(ready, "utf8")).toBe("keep");
  });
});
