import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { errorRecord, parseEnvelope, runCli, type CliResult } from "../helpers/cli-result";

const CANARY_KEY = "test_key_CANARY";
const CANARY_TOKEN = "SECRET_CANARY";
const CALL_TIMEOUT_MS = 30_000;
const AUDIO_PLAIN = "AUDIO";
const AUDIO_B64 = Buffer.from(AUDIO_PLAIN, "utf8").toString("base64");
const EXPECTED_AUDIO = Buffer.concat([
  Buffer.from(AUDIO_PLAIN, "utf8"),
  Buffer.from(AUDIO_PLAIN, "utf8"),
]);

function readAllSessionFiles(dir: string): string {
  const names = readdirSync(dir, { recursive: true }) as string[];
  return names
    .filter((name) => !name.endsWith("/"))
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .join("\n");
}

describe("ws mock server (black-box, integration gate)", () => {
  let wss: WebSocketServer;
  let wsPort: number;
  let cacheDir: string;
  let clientPongSeen = false;

  // Async spawn (NOT spawnSync): the mock server runs in THIS process, so the event
  // loop must stay free to service the spawned CLI's request — spawnSync would deadlock.
  function runElv(args: string[], env?: Record<string, string>): Promise<CliResult> {
    return runCli(args, {
      ELEVENLABS_API_KEY: CANARY_KEY,
      ELV_CACHE_DIR: cacheDir,
      ...env,
    });
  }

  function writeScript(lines: string[]): string {
    const scriptPath = join(tmpdir(), `elv-ws-script-${Date.now()}-${Math.random()}.ndjson`);
    writeFileSync(scriptPath, `${lines.join("\n")}\n`, "utf8");
    return scriptPath;
  }

  function validScriptLines(): string[] {
    // Spec §10: every line is the wrapped form; an empty-text send force-generates and closes.
    return [
      JSON.stringify({ type: "send", data: { text: " " } }),
      JSON.stringify({ type: "send", data: { text: "Hello from ws test." } }),
      JSON.stringify({ type: "send", data: { text: "" } }),
      JSON.stringify({ type: "close" }),
    ];
  }

  beforeAll(async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-ws-cache-"));

    wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => wss.on("listening", () => resolve()));

    const addr = wss.address();
    if (addr === null || typeof addr === "string") {
      throw new Error("failed to bind ws mock server");
    }
    wsPort = addr.port;

    wss.on("connection", (socket: WebSocket, req) => {
      clientPongSeen = false;
      const clientMessages: string[] = [];

      socket.on("message", (data: RawData, isBinary: boolean) => {
        if (isBinary) return;
        clientMessages.push(data.toString("utf8"));
      });

      socket.on("pong", () => {
        clientPongSeen = true;
      });

      socket.send(JSON.stringify({ audio: AUDIO_B64 }));
      socket.send(JSON.stringify({ audio: AUDIO_B64 }));

      socket.ping();

      setTimeout(() => {
        if (req.url?.includes("hang")) {
          return;
        }
        socket.close(1000, "mock done");
      }, 250);
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      wss.close((err) => (err ? reject(err) : resolve()));
    });
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it(
    "scripted session records events, decodes audio, and redacts credentials (AC #17)",
    async () => {
      const scriptPath = writeScript(validScriptLines());
      const outDir = mkdtempSync(join(tmpdir(), "elv-ws-out-"));

      try {
        const wsUrl = `ws://127.0.0.1:${wsPort}/stream-input`;
        const { stdout, stderr, code } = await runElv([
          "ws",
          wsUrl,
          "--query",
          `single_use_token=${CANARY_TOKEN}`,
          "--send",
          scriptPath,
          "--out",
          outDir,
        ]);

        expect(code).toBe(0);

        const envelope = parseEnvelope(stdout);
        expect(envelope.ok).toBe(true);

        const wsMeta = envelope.ws as Record<string, unknown>;
        expect(wsMeta).toBeDefined();
        expect(Number(wsMeta.events_received)).toBeGreaterThan(0);
        expect(wsMeta.closed).toBe(true);

        expect(existsSync(join(outDir, "events.received.ndjson"))).toBe(true);
        expect(existsSync(join(outDir, "manifest.json"))).toBe(true);

        const audioFiles = readdirSync(outDir).filter((name) => name.startsWith("audio."));
        expect(audioFiles.length).toBeGreaterThan(0);

        const audioPath = join(outDir, audioFiles[0]!);
        const audioBytes = readFileSync(audioPath);
        expect(audioBytes.equals(EXPECTED_AUDIO)).toBe(true);
        expect(audioBytes.toString("utf8")).not.toContain('"audio"');

        const sessionText = readAllSessionFiles(outDir);
        expect(sessionText).not.toContain(CANARY_KEY);
        expect(sessionText).not.toContain(CANARY_TOKEN);
        expect(stdout).not.toContain(CANARY_TOKEN);
        expect(stderr).not.toContain(CANARY_TOKEN);

        expect(clientPongSeen).toBe(true);
      } finally {
        rmSync(scriptPath, { force: true });
        rmSync(outDir, { recursive: true, force: true });
      }
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "rejects a script whose first send is not a keep-alive",
    async () => {
      const scriptPath = writeScript([
        JSON.stringify({ text: "" }),
        JSON.stringify({ type: "close" }),
      ]);
      const outDir = mkdtempSync(join(tmpdir(), "elv-ws-out-"));

      try {
        const wsUrl = `ws://127.0.0.1:${wsPort}/stream-input`;
        const { stdout, code } = await runElv(["ws", wsUrl, "--send", scriptPath, "--out", outDir]);

        expect(code).not.toBe(0);

        const envelope = parseEnvelope(stdout);
        expect(envelope.ok).toBe(false);
        errorRecord(envelope);
      } finally {
        rmSync(scriptPath, { force: true });
        rmSync(outDir, { recursive: true, force: true });
      }
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "does not apply the catalog eleven_v3 rule to a raw WS URL",
    async () => {
      const scriptPath = writeScript(validScriptLines());
      const outDir = mkdtempSync(join(tmpdir(), "elv-ws-out-"));

      try {
        const wsUrl = `ws://127.0.0.1:${wsPort}/stream-input`;
        const { stdout, code } = await runElv([
          "ws",
          wsUrl,
          "--query",
          "model_id=eleven_v3",
          "--send",
          scriptPath,
          "--out",
          outDir,
        ]);

        expect(code).toBe(0);

        const envelope = parseEnvelope(stdout);
        expect(envelope.ok).toBe(true);
      } finally {
        rmSync(scriptPath, { force: true });
        rmSync(outDir, { recursive: true, force: true });
      }
    },
    CALL_TIMEOUT_MS,
  );
});
