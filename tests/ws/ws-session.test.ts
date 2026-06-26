import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWs } from "../../src/commands/ws";
import { parseSendScript } from "../../src/ws/events";
import { runWsSession } from "../../src/ws/session";

const dirs: string[] = [];
let servers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  servers = [];
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ws session", () => {
  it("plays a send script, auto-pongs, drains audio after script close, and redacts files", async () => {
    const server = await startServer((socket, received) => {
      let sawPong = false;
      let finalAudioSent = false;
      const closeWhenReady = (): void => {
        if (sawPong && finalAudioSent) socket.close(1000, "done");
      };
      socket.send(
        JSON.stringify({ type: "ping", event_id: "evt-secret", single_use_token: "tok_secret" }),
      );
      socket.send(JSON.stringify({ audio: Buffer.from("one").toString("base64") }));
      socket.on("message", () => {
        const payload = JSON.parse(received.at(-1)!) as { type?: string; text?: string };
        if (payload.type === "pong") {
          sawPong = true;
          socket.send(JSON.stringify({ type: "pong_ack" }));
          closeWhenReady();
        }
        if (payload.text === "") {
          socket.send(
            JSON.stringify({ audio_base64: Buffer.from("two").toString("base64") }),
            () => {
              finalAudioSent = true;
              closeWhenReady();
            },
          );
        }
      });
    });
    const dir = await tempDir();
    const script = join(dir, "script.ndjson");
    writeFileSync(
      script,
      [
        { type: "send", data: { text: " ", xi_api_key: "sk_test_LEAK_CANARY" } },
        { type: "send", data: { text: "Hello " } },
        { type: "send", data: { text: "" } },
        { type: "close" },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
    );

    const result = await runWs(
      {
        target: server.url,
        send: script,
        out: dir,
        query: {
          single_use_token: "tok_secret",
          output_format: "mp3_44100_128",
        },
      },
      {
        apiKey: "sk_test_LEAK_CANARY",
        timeoutMs: 500,
      },
    );

    expect(result.env.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    if (!result.env.ok) throw new Error("expected success");
    expect(result.env.ws).toMatchObject({ catalog: null, events_sent: 3, closed: true });
    expect(
      server.received.some(
        (line) => line.includes('"type":"pong"') && line.includes('"event_id":"evt-secret"'),
      ),
    ).toBe(true);

    const audioPath = join(dir, "audio.mp3");
    expect(readFileSync(audioPath, "utf8")).toBe("onetwo");
    const events = readFileSync(join(dir, "events.received.ndjson"), "utf8");
    const manifest = readFileSync(join(dir, "manifest.json"), "utf8");
    expect(`${events}\n${manifest}`).not.toContain("sk_test_LEAK_CANARY");
    expect(`${events}\n${manifest}`).not.toContain("tok_secret");
  });

  it("rejects invalid scripts before connecting", async () => {
    const server = await startServer(() => undefined);
    const dir = await tempDir();
    const script = join(dir, "bad.ndjson");
    writeFileSync(script, JSON.stringify({ type: "send", data: { text: "Hello" } }));

    const result = await runWs(
      { target: server.url, send: script, out: dir, query: {} },
      { timeoutMs: 100 },
    );

    expect(result.env.ok).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(server.connected).toBe(false);
  });

  it("does not send the profile API key to raw absolute WebSocket targets", async () => {
    const server = await startServer((socket) => {
      socket.on("message", () => socket.close(1000, "done"));
    });
    const dir = await tempDir();
    const script = join(dir, "script.ndjson");
    writeFileSync(script, JSON.stringify({ type: "send", data: { text: " " } }));

    const result = await runWs(
      { target: server.url, send: script, out: dir, query: {} },
      {
        apiKey: "sk_test_LEAK_CANARY",
        timeoutMs: 500,
      },
    );

    expect(result.env.ok).toBe(true);
    expect(server.headers["xi-api-key"]).toBeUndefined();
  });

  it("rejects eleven_v3 for catalog targets", async () => {
    const dir = await tempDir();
    const script = join(dir, "script.ndjson");
    writeFileSync(script, JSON.stringify({ type: "send", data: { text: " " } }));

    const result = await runWs(
      {
        target: "tts-realtime",
        send: script,
        out: dir,
        query: { voice_id: "v1", model_id: "eleven_v3" },
      },
      {
        baseUrl: "http://127.0.0.1:1",
        timeoutMs: 100,
      },
    );

    expect(result.env.ok).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.env.ok ? undefined : result.env.error.message).toContain("eleven_v3");
  });

  it("maps malformed config files to config validation errors", async () => {
    const dir = await tempDir();
    const config = join(dir, "config.json");
    writeFileSync(config, "{not-json");
    const previous = process.env.ELV_CONFIG;
    process.env.ELV_CONFIG = config;
    try {
      const result = await runWs({
        target: "/v1/text-to-speech/voice/stream-input",
        send: join(dir, "missing.ndjson"),
        out: dir,
        query: {},
      });

      expect(result.exitCode).toBe(2);
      expect(result.env.ok).toBe(false);
      if (result.env.ok) throw new Error("expected config failure");
      expect(result.env.error.type).toBe("config_error");
      expect(result.env.error.code).toBe("config_json_invalid");
      expect(result.env.error.raw).toMatchObject({ path: config });
    } finally {
      if (previous === undefined) delete process.env.ELV_CONFIG;
      else process.env.ELV_CONFIG = previous;
    }
  });

  it("maps session connection failures to network errors", async () => {
    const server = await startServer(() => undefined);
    const dir = await tempDir();
    const script = join(dir, "script.ndjson");
    writeFileSync(script, JSON.stringify({ type: "send", data: { text: " " } }));
    await Promise.all(servers.splice(0).map((openServer) => closeServer(openServer)));

    const result = await runWs(
      { target: server.url, send: script, out: dir, query: {} },
      { timeoutMs: 100 },
    );

    expect(result.exitCode).toBe(8);
    expect(result.env.ok).toBe(false);
    if (result.env.ok) throw new Error("expected network failure");
    expect(result.env.error).toMatchObject({
      type: "network_error",
      code: "ws_session_failed",
    });
  });

  it("runs a scripted WS session directly and writes event, audio, and manifest files", async () => {
    const server = await startServer((socket) => {
      socket.on("message", () => {
        socket.send(JSON.stringify({ audio: Buffer.from("direct").toString("base64") }), () =>
          socket.close(1000, "done"),
        );
      });
    });
    const dir = await tempDir();

    const result = await runWsSession({
      url: new URL(server.url),
      catalog: "direct-test",
      path: "/session",
      outDir: dir,
      script: parseSendScript(JSON.stringify({ type: "send", data: { text: " " } })),
      timeoutMs: 500,
      outputFormat: "opus_48000",
    });

    expect(result.ws).toMatchObject({
      catalog: "direct-test",
      path: "/session",
      events_sent: 1,
      events_received: 1,
      closed: true,
    });
    expect(readFileSync(join(dir, "audio.opus"), "utf8")).toBe("direct");
    expect(result.files.map((file) => file.path).sort()).toEqual([
      join(dir, "audio.opus"),
      join(dir, "events.received.ndjson"),
      join(dir, "manifest.json"),
    ]);
  });

  it("fails active sessions when message processing rejects", async () => {
    const originalSend = WebSocket.prototype.send;
    const sendSpy = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
      this: WebSocket,
      data: Parameters<WebSocket["send"]>[0],
      ...args: unknown[]
    ) {
      const callback = args.findLast(
        (arg): arg is (error?: Error) => void => typeof arg === "function",
      );
      if (String(data).includes('"type":"pong"')) {
        callback?.(new Error("pong failed"));
        return;
      }
      return Reflect.apply(originalSend, this, [data, ...args]);
    });
    const server = await startServer((socket) => {
      socket.send(JSON.stringify({ type: "ping", event_id: "evt_1" }));
    });
    const dir = await tempDir();

    try {
      const session = runWsSession({
        url: new URL(server.url),
        catalog: "direct-test",
        path: "/session",
        outDir: dir,
        script: parseSendScript(JSON.stringify({ type: "send", data: { text: " " } })),
        timeoutMs: 5_000,
      });
      const result = await Promise.race([
        session.then(
          () => "resolved",
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 500)),
      ]);

      expect(result).toBe("pong failed");
    } finally {
      sendSpy.mockRestore();
    }
  });

  it("fails active sessions when a WebSocket message is malformed JSON", async () => {
    const server = await startServer((socket) => {
      socket.send("{broken");
    });
    const dir = await tempDir();

    const session = runWsSession({
      url: new URL(server.url),
      catalog: "direct-test",
      path: "/session",
      outDir: dir,
      script: parseSendScript(JSON.stringify({ type: "send", data: { text: " " } })),
      timeoutMs: 5_000,
    });
    const result = await Promise.race([
      session.then(
        () => "resolved",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 500)),
    ]);

    expect(result).toContain("WebSocket message is not valid JSON");
  });

  it("parses and rejects unsupported send-script operations", () => {
    expect(() => parseSendScript('{"type":"wait"}\n')).toThrow(/unsupported/i);
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "elv-ws-"));
  dirs.push(dir);
  return dir;
}

async function startServer(onConnection: (socket: WebSocket, received: string[]) => void): Promise<{
  url: string;
  received: string[];
  connected: boolean;
  headers: IncomingHttpHeaders;
}> {
  const server = new WebSocketServer({ port: 0 });
  servers.push(server);
  const received: string[] = [];
  let connected = false;
  let headers: IncomingHttpHeaders = {};
  server.on("connection", (socket, request) => {
    connected = true;
    headers = request.headers;
    socket.on("message", (data) => received.push(data.toString()));
    onConnection(socket, received);
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  return {
    get connected() {
      return connected;
    },
    get headers() {
      return headers;
    },
    received,
    url: `ws://127.0.0.1:${address.port}/session?single_use_token=tok_secret`,
  };
}

function closeServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
