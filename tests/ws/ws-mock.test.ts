import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  errorRecord,
  parseEnvelope,
  recordValue,
  runCli,
  type CliResult,
} from "../helpers/cli-result";

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
  let clientJsonPongEventIds: unknown[] = [];
  let lastRequestUrl: string | undefined;
  let lastHeaders: IncomingHttpHeaders = {};
  let duplexResultId: unknown;
  let duplexPongId: unknown;

  // Async spawn (NOT spawnSync): the mock server runs in THIS process, so the event
  // loop must stay free to service the spawned CLI's request — spawnSync would deadlock.
  function runElv(args: string[], env?: Record<string, string>): Promise<CliResult> {
    return runCli(args, {
      ELEVENLABS_API_KEY: CANARY_KEY,
      ELV_CACHE_DIR: cacheDir,
      ...env,
    });
  }

  function runDuplexElv(
    args: string[],
    onEvent: (event: Record<string, unknown>, send: (action: unknown) => void) => void,
  ): Promise<CliResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
        env: {
          ...process.env,
          ELEVENLABS_API_KEY: CANARY_KEY,
          ELV_CACHE_DIR: cacheDir,
        },
      });
      let stdout = "";
      let stderr = "";
      let pending = "";
      const send = (action: unknown): void => {
        child.stdin.write(`${JSON.stringify(action)}\n`);
      };
      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        const text = chunk.toString();
        stderr += text;
        pending += text;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const value = JSON.parse(line) as unknown;
            if (value !== null && typeof value === "object" && !Array.isArray(value)) {
              onEvent(value as Record<string, unknown>, send);
            }
          } catch {
            // Non-event diagnostics remain captured in stderr for assertions.
          }
        }
      });
      child.on("error", reject);
      child.on("close", (code: number | null) => {
        child.stdin.destroy();
        resolve({ stdout, stderr, code });
      });
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
      clientJsonPongEventIds = [];
      lastRequestUrl = req.url;
      lastHeaders = req.headers;
      const clientMessages: string[] = [];

      socket.on("message", (data: RawData, isBinary: boolean) => {
        if (isBinary) return;
        const raw = data.toString("utf8");
        clientMessages.push(raw);
        try {
          const message = JSON.parse(raw) as { type?: unknown; event_id?: unknown };
          if (message.type === "pong") clientJsonPongEventIds.push(message.event_id);
        } catch {
          // The CLI send script is validated JSON, but keep the mock focused on observed pongs.
        }
      });

      socket.on("pong", () => {
        clientPongSeen = true;
      });

      const requestUrl = new URL(req.url ?? "/", `ws://127.0.0.1:${wsPort}`);
      if (requestUrl.searchParams.get("agent_id") === "duplex-agent") {
        duplexResultId = undefined;
        duplexPongId = undefined;
        const finish = (): void => {
          if (duplexResultId !== "dynamic-tool-42" || duplexPongId !== 4242) return;
          socket.send(JSON.stringify({ type: "agent_response", text: "tool completed" }), () =>
            socket.close(1000, "done"),
          );
        };
        socket.on("message", (data: RawData, isBinary: boolean) => {
          if (isBinary) return;
          const message = JSON.parse(data.toString()) as Record<string, unknown>;
          if (message.type === "pong") duplexPongId = message.event_id;
          if (message.type === "client_tool_result") duplexResultId = message.tool_call_id;
          finish();
        });
        socket.send(
          JSON.stringify({
            type: "client_tool_call",
            client_tool_call: {
              tool_call_id: "dynamic-tool-42",
              tool_name: "lookup",
              parameters: { query: "weather" },
              token: "SERVER_TOKEN_SECRET",
            },
          }),
        );
        socket.send(
          JSON.stringify({
            type: "audio",
            audio_event: { audio_base_64: AUDIO_B64, event_id: 1 },
          }),
        );
        socket.send(JSON.stringify({ type: "ping", ping_event: { event_id: 4242 } }));
        return;
      }

      socket.send(JSON.stringify({ audio: AUDIO_B64 }));
      socket.send(JSON.stringify({ type: "audio", audio_event: { audio_base_64: AUDIO_B64 } }));
      socket.send(
        JSON.stringify({ type: "ping", event_id: 77, ping_event: { event_id: "malformed" } }),
      );
      socket.send(JSON.stringify({ type: "ping", ping_event: { event_id: 88, ping_ms: 5 } }));

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
    "supports a dynamic agent tool response over duplex stdin and stderr",
    async () => {
      const outDir = mkdtempSync(join(tmpdir(), "elv-ws-duplex-out-"));
      let replied = false;
      try {
        const result = await runDuplexElv(
          [
            "ws",
            "convai",
            "--duplex",
            "--yes",
            "--query",
            "agent_id=duplex-agent",
            "--base-url",
            `http://127.0.0.1:${wsPort}`,
            "--out",
            outDir,
            "--timeout-ms",
            "2000",
          ],
          (event, send) => {
            const tool = event.client_tool_call;
            if (event.type !== "client_tool_call" || tool === null || typeof tool !== "object") {
              return;
            }
            const toolCallId = (tool as Record<string, unknown>).tool_call_id;
            if (typeof toolCallId !== "string" || replied) return;
            replied = true;
            send({
              type: "send",
              data: { type: "client_tool_result", tool_call_id: toolCallId, result: "sunny" },
            });
          },
        );

        expect(result.code).toBe(0);
        const envelope = parseEnvelope(result.stdout);
        expect(envelope.ok).toBe(true);
        expect(replied).toBe(true);
        expect(duplexResultId).toBe("dynamic-tool-42");
        expect(duplexPongId).toBe(4242);
        expect(result.stderr).toContain("dynamic-tool-42");
        expect(result.stderr).toContain("tool completed");
        expect(result.stderr).not.toContain("SERVER_TOKEN_SECRET");
        expect(result.stderr).not.toContain(AUDIO_B64);
        expect(readFileSync(join(outDir, "audio.mp3"), "utf8")).toBe(AUDIO_PLAIN);
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    },
    CALL_TIMEOUT_MS,
  );

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

        const wsMeta = recordValue(envelope.ws, "ws");
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
        expect(clientJsonPongEventIds).toEqual([88]);
      } finally {
        rmSync(scriptPath, { force: true });
        rmSync(outDir, { recursive: true, force: true });
      }
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "wires token-env and url-env without exposing WebSocket credentials",
    async () => {
      const outDir = mkdtempSync(join(tmpdir(), "elv-ws-auth-out-"));
      const sttScript = writeScript([
        JSON.stringify({
          type: "send",
          data: {
            message_type: "input_audio_chunk",
            audio_base_64: AUDIO_B64,
            commit: true,
            sample_rate: 16_000,
          },
        }),
      ]);
      const convaiScript = writeScript([
        JSON.stringify({ type: "send", data: { type: "user_message", text: "hello" } }),
      ]);
      const token = "TOKEN_ENV_SECRET";
      const signature = "SIGNED_URL_SECRET";

      try {
        const stt = await runElv(
          [
            "ws",
            "stt-realtime",
            "--token-env",
            "ELV_TEST_WS_TOKEN",
            "--send",
            sttScript,
            "--out",
            outDir,
            "--base-url",
            `http://127.0.0.1:${wsPort}`,
          ],
          { ELV_TEST_WS_TOKEN: token },
        );
        expect(stt.code).toBe(0);
        expect(new URL(lastRequestUrl!, `ws://127.0.0.1:${wsPort}`).searchParams.get("token")).toBe(
          token,
        );
        expect(`${stt.stdout}\n${stt.stderr}\n${readAllSessionFiles(outDir)}`).not.toContain(token);

        const signedUrl = `ws://127.0.0.1:${wsPort}/v1/convai/conversation?conversation_signature=${signature}`;
        const convai = await runElv(
          [
            "ws",
            "--url-env",
            "ELV_TEST_SIGNED_URL",
            "--send",
            convaiScript,
            "--yes",
            "--out",
            outDir,
          ],
          { ELV_TEST_SIGNED_URL: signedUrl },
        );
        expect(convai.code).toBe(0);
        expect(lastRequestUrl).toContain(`conversation_signature=${signature}`);
        expect(lastHeaders["xi-api-key"]).toBeUndefined();
        expect(`${convai.stdout}\n${convai.stderr}\n${readAllSessionFiles(outDir)}`).not.toContain(
          signature,
        );
      } finally {
        rmSync(sttScript, { force: true });
        rmSync(convaiScript, { force: true });
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
