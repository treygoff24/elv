import { readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWs } from "../../src/commands/ws";
import { MAX_BINARY_FILE_BYTES, parseSendScript } from "../../src/ws/events";
import {
  DuplexActionReader,
  runDuplexSession,
  runWsSession,
  type WsSessionState,
} from "../../src/ws/session";

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
        JSON.stringify({
          type: "ping",
          event_id: "decoy-event",
          ping_event: { event_id: "not-an-integer" },
        }),
      );
      socket.send(
        JSON.stringify({
          type: "ping",
          ping_event: { event_id: 123456, ping_ms: 50 },
          single_use_token: "tok_secret",
        }),
      );
      socket.send(JSON.stringify({ audio: Buffer.from("one").toString("base64") }));
      socket.on("message", () => {
        const payload = JSON.parse(received.at(-1)!) as {
          type?: string;
          text?: string;
          event_id?: unknown;
        };
        if (payload.type === "pong" && payload.event_id === 123456) {
          sawPong = true;
          socket.send(JSON.stringify({ type: "pong_ack" }));
          closeWhenReady();
        }
        if (payload.text === "") {
          socket.send(
            JSON.stringify({
              type: "audio",
              audio_event: { audio_base_64: Buffer.from("two").toString("base64") },
            }),
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
        (line) => line.includes('"type":"pong"') && line.includes('"event_id":123456'),
      ),
    ).toBe(true);
    expect(server.received.some((line) => line.includes('"event_id":"decoy-event"'))).toBe(false);

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
    writeFileSync(script, JSON.stringify({ type: "wait" }));

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

  it("rejects protocol-relative WebSocket paths before attaching profile auth", async () => {
    const dir = await tempDir();
    const script = join(dir, "script.ndjson");
    writeFileSync(script, JSON.stringify({ type: "send", data: { text: " " } }));

    const result = await runWs(
      { target: "//evil.example/steal", send: script, out: dir, query: {} },
      { baseUrl: "https://api.elevenlabs.io", apiKey: "sk_profile", dryRun: true },
    );

    expect(result.exitCode).toBe(2);
    expect(result.env.ok).toBe(false);
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

  it("keeps the whitespace handshake requirement on catalog TTS only", async () => {
    const server = await startServer(() => undefined);
    const dir = await tempDir();
    const script = join(dir, "script.ndjson");
    writeFileSync(script, JSON.stringify({ type: "send", data: { text: "Hello" } }));

    const result = await runWs(
      {
        target: "tts-realtime",
        send: script,
        out: dir,
        query: { voice_id: "v1" },
      },
      { baseUrl: httpBase(server.url), timeoutMs: 100 },
    );

    expect(result.exitCode).toBe(2);
    expect(result.env.ok).toBe(false);
    expect(server.connected).toBe(false);
  });

  it("runs the published single-context Text to Dialogue protocol", async () => {
    const server = await startServer((socket, received) => {
      socket.on("message", () => {
        const message = JSON.parse(received.at(-1)!) as Record<string, unknown>;
        if (message.close_socket === true) {
          socket.send(JSON.stringify({ audio: Buffer.from("dialogue").toString("base64") }));
          socket.send(JSON.stringify({ is_final: true }), () => socket.close(1000, "done"));
        }
      });
    });
    const dir = await tempDir();
    const script = join(dir, "dialogue.ndjson");
    writeFileSync(
      script,
      [
        { type: "send", data: { voices: ["voice-a"] } },
        {
          type: "send",
          data: { inputs: [{ text: "Hello there", voice_id: "voice-a", new_turn: true }] },
        },
        { type: "send", data: { flush: true } },
        { type: "send", data: { close_socket: true } },
        { type: "close" },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
    );

    const result = await runWs(
      { target: "ttd-realtime", send: script, out: dir, query: {} },
      { baseUrl: httpBase(server.url), apiKey: "sk_test", timeoutMs: 500 },
    );

    expect(result.exitCode).toBe(0);
    expect(server.received.map((raw) => JSON.parse(raw))).toEqual([
      { voices: ["voice-a"] },
      { inputs: [{ text: "Hello there", voice_id: "voice-a", new_turn: true }] },
      { flush: true },
      { close_socket: true },
    ]);
    expect(readFileSync(join(dir, "audio.mp3"), "utf8")).toBe("dialogue");
    if (!result.env.ok) throw new Error("expected success");
    expect(result.env.cost?.credits_estimated).toBe(11);
  });

  it("separates and safely names multi-context Text to Dialogue audio", async () => {
    const server = await startServer((socket, received) => {
      socket.on("message", () => {
        const message = JSON.parse(received.at(-1)!) as Record<string, unknown>;
        if (message.close_socket === true) {
          socket.send(
            JSON.stringify({
              audio: Buffer.from("a1").toString("base64"),
              context_id: "../../alpha",
            }),
          );
          socket.send(JSON.stringify({ is_final: true, context_id: "../../alpha" }));
          socket.send(
            JSON.stringify({ audio: Buffer.from("b1").toString("base64"), contextId: "beta" }),
          );
          socket.send(JSON.stringify({ is_final: true, context_id: "beta" }), () =>
            socket.close(1000, "done"),
          );
        }
      });
    });
    const dir = await tempDir();
    const script = join(dir, "dialogue-multi.ndjson");
    writeFileSync(
      script,
      [
        { type: "send", data: { context_id: "../../alpha", voices: ["voice-a"] } },
        { type: "send", data: { context_id: "beta", voices: ["voice-b"] } },
        {
          type: "send",
          data: {
            context_id: "../../alpha",
            inputs: [{ text: "Alpha", voice_id: "voice-a" }],
          },
        },
        {
          type: "send",
          data: { context_id: "beta", inputs: [{ text: "Beta", voice_id: "voice-b" }] },
        },
        { type: "send", data: { context_id: "../../alpha", close_context: true } },
        { type: "send", data: { close_socket: true } },
        { type: "close" },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
    );

    const result = await runWs(
      { target: "ttd-multi", send: script, out: dir, query: { model_id: "eleven_v3" } },
      { baseUrl: httpBase(server.url), timeoutMs: 500 },
    );

    expect(result.exitCode).toBe(0);
    if (!result.env.ok) throw new Error("expected success");
    const audioFiles = result.env.files?.filter((file) => file.path.includes("/audio.")) ?? [];
    expect(audioFiles).toHaveLength(2);
    expect(audioFiles.every((file) => file.path.startsWith(`${dir}/`))).toBe(true);
    expect(audioFiles.every((file) => !file.path.slice(dir.length + 1).includes(".."))).toBe(true);
    expect(audioFiles.map((file) => readFileSync(file.path, "utf8")).sort()).toEqual(["a1", "b1"]);
    expect(server.received.map((raw) => JSON.parse(raw)).slice(-2)).toEqual([
      { context_id: "../../alpha", close_context: true },
      { close_socket: true },
    ]);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
      audio_files?: { context_id: string | null; file: string }[];
    };
    expect(manifest.audio_files?.map(({ context_id }) => context_id).sort()).toEqual([
      "../../alpha",
      "beta",
    ]);
  });

  it("rejects invalid TTD model and voice cardinality before connecting", async () => {
    const server = await startServer(() => undefined);
    const dir = await tempDir();
    const script = join(dir, "dialogue.ndjson");
    writeFileSync(
      script,
      JSON.stringify({ type: "send", data: { voices: ["voice-a", "voice-b"] } }),
    );

    const voicesResult = await runWs(
      { target: "ttd-realtime", send: script, out: dir, query: {} },
      { baseUrl: httpBase(server.url), timeoutMs: 100 },
    );
    expect(voicesResult.exitCode).toBe(2);
    expect(server.connected).toBe(false);

    writeFileSync(script, JSON.stringify({ type: "send", data: { voices: ["voice-a"] } }));
    const modelResult = await runWs(
      {
        target: "ttd-realtime",
        send: script,
        out: dir,
        query: { model_id: "eleven_flash_v2_5" },
      },
      { baseUrl: httpBase(server.url), timeoutMs: 100 },
    );
    expect(modelResult.exitCode).toBe(2);
    expect(server.connected).toBe(false);
  });

  it("bounds TTD nested input text before connecting", async () => {
    const server = await startServer(() => undefined);
    const dir = await tempDir();
    const script = join(dir, "dialogue.ndjson");
    writeFileSync(
      script,
      [
        { type: "send", data: { voices: ["voice-a"] } },
        {
          type: "send",
          data: { inputs: [{ text: "This is chargeable.", voice_id: "voice-a" }] },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
    );

    const result = await runWs(
      { target: "ttd-realtime", send: script, out: dir, query: {} },
      { baseUrl: httpBase(server.url), maxCredits: 1, timeoutMs: 100 },
    );

    expect(result.exitCode).toBe(5);
    expect(server.connected).toBe(false);
  });

  it("wraps an STT audio file in the published input_audio_chunk message", async () => {
    const outbound = Buffer.from([0, 1, 2, 127, 128, 254, 255]);
    const inbound = Buffer.from([255, 4, 3, 2, 1, 0]);
    let received: Record<string, unknown> | undefined;
    const server = await startServer((socket) => {
      socket.on("message", (data, isBinary) => {
        if (isBinary) return;
        received = JSON.parse(data.toString()) as Record<string, unknown>;
        socket.send(inbound, { binary: true }, () => socket.close(1000, "done"));
      });
    });
    const dir = await tempDir();
    const audio = join(dir, "audio.raw");
    const script = join(dir, "script.ndjson");
    writeFileSync(audio, outbound);
    writeFileSync(
      script,
      JSON.stringify({
        type: "send_audio_file",
        path: "audio.raw",
        sample_rate: 16_000,
        commit: true,
        previous_text: "Earlier context",
      }),
    );

    const result = await runWs(
      {
        target: "stt-realtime",
        send: script,
        out: dir,
        query: {},
      },
      { baseUrl: httpBase(server.url), apiKey: "sk_test", timeoutMs: 500 },
    );

    expect(result.exitCode).toBe(0);
    expect(received).toEqual({
      message_type: "input_audio_chunk",
      audio_base_64: outbound.toString("base64"),
      commit: true,
      sample_rate: 16_000,
      previous_text: "Earlier context",
    });
    if (!result.env.ok) throw new Error("expected success");
    const binaryFile = result.env.files?.find((file) => file.path.includes("binary.received"));
    expect(binaryFile).toBeDefined();
    expect(readFileSync(binaryFile!.path).equals(inbound)).toBe(true);
  });

  it("keeps exact binary sends available only for raw WebSocket sessions", async () => {
    const outbound = Buffer.from([0, 1, 2, 255]);
    let received: Buffer | undefined;
    const server = await startServer((socket) => {
      socket.on("message", (data, isBinary) => {
        if (!isBinary) return;
        received = Buffer.from(data as Buffer);
        socket.close(1000, "done");
      });
    });
    const dir = await tempDir();
    const audio = join(dir, "audio.raw");
    const script = join(dir, "script.ndjson");
    writeFileSync(audio, outbound);
    writeFileSync(script, JSON.stringify({ type: "send_binary_file", path: "audio.raw" }));

    const result = await runWs(
      { target: server.url, send: script, out: dir, query: {} },
      { timeoutMs: 500 },
    );

    expect(result.exitCode).toBe(0);
    expect(received?.equals(outbound)).toBe(true);
  });

  it("rejects raw binary and malformed audio-file actions for named STT before connecting", async () => {
    const server = await startServer(() => undefined);
    const dir = await tempDir();
    const audio = join(dir, "audio.raw");
    const script = join(dir, "script.ndjson");
    writeFileSync(audio, "audio");
    writeFileSync(script, JSON.stringify({ type: "send_binary_file", path: "audio.raw" }));

    const binaryResult = await runWs(
      { target: "stt-realtime", send: script, out: dir, query: {} },
      { baseUrl: httpBase(server.url), timeoutMs: 100 },
    );
    expect(binaryResult.exitCode).toBe(2);
    expect(server.connected).toBe(false);

    writeFileSync(
      script,
      JSON.stringify({ type: "send_audio_file", path: "audio.raw", commit: true }),
    );
    const malformedResult = await runWs(
      { target: "stt-realtime", send: script, out: dir, query: {} },
      { baseUrl: httpBase(server.url), timeoutMs: 100 },
    );
    expect(malformedResult.exitCode).toBe(2);
    expect(server.connected).toBe(false);
  });

  it("runs the monitor receive-only and authenticates only its configured host", async () => {
    const server = await startServer((socket) => {
      socket.send(JSON.stringify({ type: "transcript", text: "hello" }), () =>
        socket.close(1000, "done"),
      );
    });
    const dir = await tempDir();

    const result = await runWs(
      {
        target: "convai-monitor",
        out: dir,
        query: { conversation_id: "conv-1" },
      },
      { baseUrl: httpBase(server.url), apiKey: "sk_monitor", timeoutMs: 500 },
    );

    expect(result.exitCode).toBe(0);
    expect(server.headers["xi-api-key"]).toBe("sk_monitor");
    expect(readFileSync(join(dir, "events.received.ndjson"), "utf8")).toContain("transcript");
  });

  it("gates outbound monitor controls before connecting", async () => {
    const server = await startServer((socket) => {
      socket.on("message", () => socket.close(1000, "done"));
    });
    const dir = await tempDir();
    const script = join(dir, "control.ndjson");
    writeFileSync(script, JSON.stringify({ type: "send", data: { type: "end_call" } }));

    const result = await runWs(
      {
        target: "convai-monitor",
        send: script,
        out: dir,
        query: { conversation_id: "conv-1" },
      },
      { baseUrl: httpBase(server.url), apiKey: "sk_monitor", timeoutMs: 100 },
    );

    expect(result.exitCode).toBe(4);
    expect(result.env.ok).toBe(false);
    expect(server.connected).toBe(false);

    const agentResult = await runWs(
      {
        target: "convai",
        send: script,
        out: dir,
        query: { agent_id: "agent-1" },
      },
      { baseUrl: httpBase(server.url), apiKey: "sk_agent", timeoutMs: 100 },
    );
    expect(agentResult.exitCode).toBe(4);
    expect(server.connected).toBe(false);

    const allowed = await runWs(
      {
        target: "convai-monitor",
        send: script,
        out: dir,
        query: { conversation_id: "conv-1" },
      },
      { baseUrl: httpBase(server.url), apiKey: "sk_monitor", yes: true, timeoutMs: 500 },
    );
    expect(allowed.exitCode).toBe(0);
    expect(server.received).toContain('{"type":"end_call"}');
  });

  it("retains agent_id when connecting through the named public-agent target", async () => {
    const server = await startServer((socket) => {
      socket.on("message", () => socket.close(1000, "done"));
    });
    const dir = await tempDir();
    const script = join(dir, "agent.ndjson");
    writeFileSync(script, JSON.stringify({ type: "send", data: { type: "user_message" } }));

    const result = await runWs(
      {
        target: "convai",
        send: script,
        out: dir,
        query: { agent_id: "agent-public" },
      },
      { baseUrl: httpBase(server.url), apiKey: "sk_agent", yes: true, timeoutMs: 500 },
    );

    expect(result.exitCode).toBe(0);
    expect(new URL(server.requestUrl!, server.url).searchParams.get("agent_id")).toBe(
      "agent-public",
    );
  });

  it("inherits agent preflight metadata for named, relative, and absolute known targets", async () => {
    const dir = await tempDir();
    const script = join(dir, "agent.ndjson");
    writeFileSync(script, JSON.stringify({ type: "send", data: { type: "user_message" } }));

    const named = await startServer(() => undefined);
    const namedResult = await runWs(
      {
        target: "convai",
        send: script,
        out: dir,
        query: { agent_id: "agent-1" },
      },
      { baseUrl: httpBase(named.url), timeoutMs: 100 },
    );
    expect(namedResult.exitCode).toBe(4);
    expect(named.connected).toBe(false);

    const relative = await startServer(() => undefined);
    const relativeResult = await runWs(
      {
        target: "/v1/convai/conversation",
        send: script,
        out: dir,
        query: { agent_id: "agent-1" },
      },
      { baseUrl: httpBase(relative.url), timeoutMs: 100 },
    );
    expect(relativeResult.exitCode).toBe(4);
    expect(relative.connected).toBe(false);

    const absolute = await startServer(() => undefined);
    const absoluteUrl = new URL(absolute.url);
    absoluteUrl.pathname = "/v1/convai/conversation";
    const absoluteResult = await runWs(
      { target: absoluteUrl.toString(), send: script, out: dir, query: { agent_id: "agent-1" } },
      { apiKey: "MUST_NOT_LEAK", timeoutMs: 100 },
    );
    expect(absoluteResult.exitCode).toBe(4);
    expect(absolute.connected).toBe(false);
  });

  it("inherits monitor confirmation gates for configured-host raw paths", async () => {
    const server = await startServer(() => undefined);
    const dir = await tempDir();
    const script = join(dir, "control.ndjson");
    writeFileSync(script, JSON.stringify({ type: "send", data: { type: "end_call" } }));

    const result = await runWs(
      {
        target: "/v1/convai/conversations/conv-1/monitor",
        send: script,
        out: dir,
        query: {},
      },
      { baseUrl: httpBase(server.url), apiKey: "sk_monitor", timeoutMs: 100 },
    );

    expect(result.exitCode).toBe(4);
    expect(result.env.ok).toBe(false);
    expect(server.connected).toBe(false);
  });

  it("rejects oversized binary actions before connecting", async () => {
    const server = await startServer(() => undefined);
    const dir = await tempDir();
    const audio = join(dir, "oversized.raw");
    const script = join(dir, "script.ndjson");
    writeFileSync(audio, "");
    truncateSync(audio, MAX_BINARY_FILE_BYTES + 1);
    writeFileSync(script, JSON.stringify({ type: "send_binary_file", path: audio }));

    const result = await runWs(
      { target: "stt-realtime", send: script, out: dir, query: {} },
      { baseUrl: httpBase(server.url), timeoutMs: 100 },
    );

    expect(result.exitCode).toBe(2);
    expect(result.env.ok).toBe(false);
    expect(server.connected).toBe(false);
  });

  it("dry-runs without connecting and redacts WS credentials and actions", async () => {
    const server = await startServer(() => undefined);
    const dir = await tempDir();
    const script = join(dir, "control.ndjson");
    writeFileSync(
      script,
      JSON.stringify({
        type: "send",
        data: { type: "send_human_message", token: "SCRIPT_SECRET" },
      }),
    );

    const result = await runWs(
      {
        target: "convai-monitor",
        send: script,
        out: dir,
        query: { conversation_id: "conv-1", single_use_token: "URL_SECRET" },
      },
      {
        baseUrl: httpBase(server.url),
        apiKey: "HEADER_SECRET",
        dryRun: true,
        timeoutMs: 100,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(server.connected).toBe(false);
    const serialized = JSON.stringify(result.env);
    expect(serialized).not.toContain("SCRIPT_SECRET");
    expect(serialized).not.toContain("URL_SECRET");
    expect(serialized).not.toContain("HEADER_SECRET");
    expect(serialized).toContain("would_require_yes");
  });

  it("reads protocol-specific WebSocket tokens from an environment variable", async () => {
    const tokenName = "ELV_TEST_WS_TOKEN";
    const original = process.env[tokenName];
    process.env[tokenName] = "TOKEN_SECRET";
    const server = await startServer((socket) => {
      socket.on("message", () => socket.close(1000, "done"));
    });
    const dir = await tempDir();
    const script = join(dir, "script.ndjson");
    writeFileSync(
      script,
      JSON.stringify({
        type: "send",
        data: {
          message_type: "input_audio_chunk",
          audio_base_64: Buffer.from("audio").toString("base64"),
          commit: true,
          sample_rate: 16_000,
        },
      }),
    );

    try {
      const result = await runWs(
        { target: "stt-realtime", tokenEnv: tokenName, send: script, out: dir, query: {} },
        { baseUrl: httpBase(server.url), timeoutMs: 500 },
      );

      expect(result.exitCode).toBe(0);
      expect(new URL(server.requestUrl!, server.url).searchParams.get("token")).toBe(
        "TOKEN_SECRET",
      );
      expect(readFileSync(join(dir, "manifest.json"), "utf8")).not.toContain("TOKEN_SECRET");
    } finally {
      if (original === undefined) delete process.env[tokenName];
      else process.env[tokenName] = original;
    }
  });

  it("maps token-env to single_use_token for Text to Dialogue", async () => {
    const tokenName = "ELV_TEST_TTD_TOKEN";
    const original = process.env[tokenName];
    process.env[tokenName] = "TTD_TOKEN_SECRET";
    const server = await startServer((socket) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.close_socket === true) socket.close(1000, "done");
      });
    });
    const dir = await tempDir();
    const script = join(dir, "script.ndjson");
    writeFileSync(
      script,
      [
        { type: "send", data: { voices: ["voice-a"] } },
        { type: "send", data: { close_socket: true } },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
    );

    try {
      const result = await runWs(
        { target: "ttd-realtime", tokenEnv: tokenName, send: script, out: dir, query: {} },
        { baseUrl: httpBase(server.url), timeoutMs: 500 },
      );

      expect(result.exitCode).toBe(0);
      expect(new URL(server.requestUrl!, server.url).searchParams.get("single_use_token")).toBe(
        "TTD_TOKEN_SECRET",
      );
      expect(readFileSync(join(dir, "manifest.json"), "utf8")).not.toContain("TTD_TOKEN_SECRET");
    } finally {
      if (original === undefined) delete process.env[tokenName];
      else process.env[tokenName] = original;
    }
  });

  it("refuses --token-env when the target host is not the configured API host", async () => {
    const tokenName = "ELV_TEST_FOREIGN_WS_TOKEN";
    const original = process.env[tokenName];
    process.env[tokenName] = "FOREIGN_TOKEN_SECRET";
    const dir = await tempDir();
    const script = join(dir, "stt.ndjson");
    writeFileSync(
      script,
      JSON.stringify({
        type: "send",
        data: {
          message_type: "input_audio_chunk",
          audio_base_64: "AAAA",
          commit: true,
          sample_rate: 16_000,
        },
      }),
    );

    try {
      const result = await runWs(
        {
          target: "wss://attacker.example.com/v1/speech-to-text/realtime",
          tokenEnv: tokenName,
          send: script,
          out: dir,
          query: {},
        },
        { baseUrl: "https://api.elevenlabs.io", dryRun: true },
      );

      expect(result.exitCode).toBe(2);
      const serialized = JSON.stringify(result.env);
      expect(serialized).not.toContain("FOREIGN_TOKEN_SECRET");
      expect(serialized).toContain("attacker.example.com");
      expect(serialized).toContain("api.elevenlabs.io");
    } finally {
      if (original === undefined) delete process.env[tokenName];
      else process.env[tokenName] = original;
    }
  });

  it("does not label a foreign WebSocket host with a catalog name it keeps enforcing", async () => {
    const dir = await tempDir();
    const script = join(dir, "raw.ndjson");
    writeFileSync(
      script,
      JSON.stringify({
        type: "send",
        data: {
          message_type: "input_audio_chunk",
          audio_base_64: "AAAA",
          commit: true,
          sample_rate: 16_000,
        },
      }),
    );

    const result = await runWs(
      {
        target: "wss://attacker.example.com/v1/speech-to-text/realtime",
        send: script,
        out: dir,
        query: {},
      },
      { baseUrl: "https://api.elevenlabs.io", dryRun: true },
    );

    expect(result.exitCode).toBe(0);
    const serialized = JSON.stringify(result.env);
    expect(serialized).toContain('"catalog":null');
    // The path match still supplies the protocol rules and budget policy: only the
    // catalog label, which would claim a known ElevenLabs route, is withheld.
    expect(serialized).toContain('"protocol":"stt"');
    expect(serialized).toContain('"budget_policy"');
  });

  it("reads a signed WebSocket URL from an environment variable without profile auth", async () => {
    const urlName = "ELV_TEST_SIGNED_WS_URL";
    const original = process.env[urlName];
    const server = await startServer((socket) => {
      socket.on("message", () => socket.close(1000, "done"));
    });
    const signedUrl = new URL(server.url);
    signedUrl.pathname = "/v1/convai/conversation";
    signedUrl.searchParams.set("conversation_signature", "SIGNED_SECRET");
    process.env[urlName] = signedUrl.toString();
    const dir = await tempDir();
    const script = join(dir, "script.ndjson");
    writeFileSync(script, JSON.stringify({ type: "send", data: { type: "user_message" } }));

    try {
      const gated = await runWs(
        { urlEnv: urlName, send: script, out: dir, query: {} },
        { apiKey: "PROFILE_SECRET", timeoutMs: 500 },
      );
      expect(gated.exitCode).toBe(4);
      expect(server.connected).toBe(false);

      const result = await runWs(
        { urlEnv: urlName, send: script, out: dir, query: {} },
        { apiKey: "PROFILE_SECRET", yes: true, timeoutMs: 500 },
      );

      expect(result.exitCode).toBe(0);
      expect(server.headers["xi-api-key"]).toBeUndefined();
      expect(server.requestUrl).toContain("conversation_signature=SIGNED_SECRET");
      const manifest = readFileSync(join(dir, "manifest.json"), "utf8");
      expect(manifest).not.toContain("SIGNED_SECRET");
      expect(manifest).not.toContain("PROFILE_SECRET");
    } finally {
      if (original === undefined) delete process.env[urlName];
      else process.env[urlName] = original;
    }
  });

  it("rejects a named protocol that contradicts a known url-env route", async () => {
    const urlName = "ELV_TEST_MISMATCHED_WS_URL";
    const original = process.env[urlName];
    process.env[urlName] = "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent-1";
    const dir = await tempDir();
    const script = join(dir, "script.ndjson");
    writeFileSync(
      script,
      [
        { type: "send", data: { text: " " } },
        { type: "send", data: { type: "user_message", text: "bypass" } },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
    );

    try {
      const result = await runWs(
        {
          target: "tts-realtime",
          urlEnv: urlName,
          send: script,
          out: dir,
          query: {},
        },
        { dryRun: true },
      );

      expect(result.exitCode).toBe(2);
      expect(result.env.ok ? undefined : result.env.error.message).toContain(
        "does not match the known WebSocket route",
      );
    } finally {
      if (original === undefined) delete process.env[urlName];
      else process.env[urlName] = original;
    }
  });

  it("allows same-protocol and unknown-gateway url-env overrides without profile auth", async () => {
    const urlName = "ELV_TEST_DECLARED_WS_URL";
    const original = process.env[urlName];
    const dir = await tempDir();
    const script = join(dir, "script.ndjson");
    writeFileSync(script, JSON.stringify({ type: "send", data: { text: " " } }));

    try {
      for (const url of [
        "wss://gateway.example/v1/text-to-speech/voice-a/stream-input",
        "wss://gateway.example/custom/tts-gateway",
      ]) {
        process.env[urlName] = url;
        const result = await runWs(
          {
            target: "tts-realtime",
            urlEnv: urlName,
            send: script,
            out: dir,
            query: {},
          },
          { apiKey: "PROFILE_SECRET", dryRun: true },
        );
        expect(result.exitCode).toBe(0);
        const serialized = JSON.stringify(result.env);
        expect(serialized).toContain('"catalog":"tts-realtime"');
        expect(serialized).not.toContain("PROFILE_SECRET");
      }
    } finally {
      if (original === undefined) delete process.env[urlName];
      else process.env[urlName] = original;
    }
  });

  it("canonicalizes relative paths before applying known-route safety metadata", async () => {
    const dir = await tempDir();
    const script = join(dir, "agent.ndjson");
    writeFileSync(script, JSON.stringify({ type: "send", data: { type: "user_message" } }));

    const result = await runWs(
      {
        target: "/v1/foo/../convai/conversation",
        send: script,
        out: dir,
        query: { agent_id: "agent-1" },
      },
      { baseUrl: "https://api.elevenlabs.io", dryRun: true },
    );

    expect(result.exitCode).toBe(0);
    const serialized = JSON.stringify(result.env);
    expect(serialized).toContain('"catalog":"convai"');
    expect(serialized).toContain('"would_require_yes":true');
  });

  it.each([
    "/%76%31/convai/conversation",
    "/v1%2Fconvai%2Fconversation",
    "wss://api.elevenlabs.io/v1%2Fconvai%2Fconversation",
  ])("decodes a known WebSocket route exactly once before preflight: %s", async (target) => {
    const dir = await tempDir();
    const script = join(dir, "agent.ndjson");
    writeFileSync(script, JSON.stringify({ type: "send", data: { type: "user_message" } }));

    const result = await runWs(
      { target, send: script, out: dir, query: { agent_id: "agent-1" } },
      { baseUrl: "https://api.elevenlabs.io", dryRun: true },
    );

    expect(result.exitCode).toBe(0);
    const serialized = JSON.stringify(result.env);
    expect(serialized).toContain('"catalog":"convai"');
    expect(serialized).toContain('"would_require_yes":true');
  });

  it("does not double-decode encoded WebSocket separators", async () => {
    const dir = await tempDir();
    const script = join(dir, "raw.ndjson");
    writeFileSync(script, JSON.stringify({ type: "send", data: { hello: "world" } }));

    const result = await runWs(
      {
        target: "/v1%252Fconvai%252Fconversation",
        send: script,
        out: dir,
        query: {},
      },
      { baseUrl: "https://api.elevenlabs.io", dryRun: true },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.stringify(result.env)).toContain('"catalog":null');
  });

  it("rejects malformed WebSocket path encoding before connecting", async () => {
    const dir = await tempDir();
    const script = join(dir, "raw.ndjson");
    writeFileSync(script, JSON.stringify({ type: "send", data: { hello: "world" } }));

    const result = await runWs(
      { target: "/v1/%ZZ/convai/conversation", send: script, out: dir, query: {} },
      { baseUrl: "https://api.elevenlabs.io", dryRun: true },
    );

    expect(result.exitCode).toBe(2);
    expect(result.env.ok ? undefined : result.env.error.message).toContain(
      "invalid percent-encoding",
    );
  });

  it("rejects a named override whose encoded URL resolves to another known route", async () => {
    const urlName = "ELV_TEST_ENCODED_MISMATCH_WS_URL";
    const original = process.env[urlName];
    process.env[urlName] = "wss://api.elevenlabs.io/v1%2Fconvai%2Fconversation";
    const dir = await tempDir();
    const script = join(dir, "tts.ndjson");
    writeFileSync(script, JSON.stringify({ type: "send", data: { text: " " } }));

    try {
      const result = await runWs(
        { target: "tts-realtime", urlEnv: urlName, send: script, out: dir, query: {} },
        { dryRun: true },
      );
      expect(result.exitCode).toBe(2);
      expect(result.env.ok ? undefined : result.env.error.message).toContain("does not match");
    } finally {
      if (original === undefined) delete process.env[urlName];
      else process.env[urlName] = original;
    }
  });

  it("applies WebSocket query precedence as defaults, embedded URL, then explicit query", async () => {
    const dir = await tempDir();
    const script = join(dir, "dialogue.ndjson");
    writeFileSync(
      script,
      JSON.stringify({ type: "send", data: { voices: ["voice-a", "voice-b"] } }),
    );

    const embedded = await runWs(
      {
        target: "/v1/text-to-dialogue/stream-input?model_id=eleven_v3&signature=SIGNED_VALUE",
        send: script,
        out: dir,
        query: {},
      },
      { baseUrl: "https://api.elevenlabs.io", dryRun: true },
    );
    expect(embedded.exitCode).toBe(0);
    const embeddedText = JSON.stringify(embedded.env);
    expect(embeddedText).toContain("model_id=eleven_v3");
    expect(embeddedText).not.toContain("SIGNED_VALUE");

    const explicit = await runWs(
      {
        target: "/v1/text-to-dialogue/stream-input?model_id=eleven_v3_conversational",
        send: script,
        out: dir,
        query: { model_id: "eleven_v3" },
      },
      { baseUrl: "https://api.elevenlabs.io", dryRun: true },
    );
    expect(explicit.exitCode).toBe(0);
    expect(JSON.stringify(explicit.env)).toContain("model_id=eleven_v3");
  });

  it("requires explicit acceptance when max-credits cannot bound a raw outbound session", async () => {
    const server = await startServer((socket) => {
      socket.on("message", () => socket.close(1000, "done"));
    });
    const dir = await tempDir();
    const script = join(dir, "raw.ndjson");
    writeFileSync(script, JSON.stringify({ type: "send", data: { hello: "world" } }));

    const gated = await runWs(
      { target: server.url, send: script, out: dir, query: {} },
      { maxCredits: 10, timeoutMs: 100 },
    );
    expect(gated.exitCode).toBe(4);
    expect(server.connected).toBe(false);

    const accepted = await runWs(
      { target: server.url, send: script, out: dir, query: {} },
      { maxCredits: 10, yes: true, timeoutMs: 500 },
    );
    expect(accepted.exitCode).toBe(0);
    expect(accepted.env.warnings).toContainEqual(
      expect.objectContaining({ code: "budget_unbounded" }),
    );

    const duplexServer = await startServer(() => undefined);
    const gatedInput = new PassThrough();
    const gatedDuplex = await runWs(
      { target: duplexServer.url, duplex: true, out: dir, query: {} },
      { duplexInput: gatedInput, maxCredits: 10, timeoutMs: 100 },
    );
    gatedInput.destroy();
    expect(gatedDuplex.exitCode).toBe(4);
    expect(duplexServer.connected).toBe(false);

    const acceptedInput = new PassThrough();
    acceptedInput.end();
    const acceptedDuplex = await runWs(
      { target: duplexServer.url, duplex: true, out: dir, query: {} },
      { duplexInput: acceptedInput, maxCredits: 10, yes: true, timeoutMs: 500 },
    );
    expect(acceptedDuplex.exitCode).toBe(0);
    expect(acceptedDuplex.env.warnings).toContainEqual(
      expect.objectContaining({ code: "budget_unbounded" }),
    );
  });

  it("requires --yes before opening dynamic agent or monitor sessions", async () => {
    const server = await startServer(() => undefined);
    const dir = await tempDir();

    for (const target of ["convai", "convai-monitor"]) {
      const input = new PassThrough();
      const result = await runWs(
        {
          target,
          duplex: true,
          out: dir,
          query: target === "convai" ? { agent_id: "agent-1" } : { conversation_id: "conv-1" },
        },
        { baseUrl: httpBase(server.url), duplexInput: input, timeoutMs: 100 },
      );
      input.destroy();
      expect(result.exitCode).toBe(4);
      expect(server.connected).toBe(false);
    }
  });

  it("streams incremental TTS after a finite initialization script", async () => {
    const server = await startServer((socket, received) => {
      socket.send(JSON.stringify({ type: "next", step: "text" }));
      socket.on("message", () => {
        const message = JSON.parse(received.at(-1)!) as Record<string, unknown>;
        if (message.text === "Hello ") {
          socket.send(JSON.stringify({ type: "next", step: "eos" }));
        } else if (message.text === "") {
          socket.send(JSON.stringify({ audio: Buffer.from("tts-live").toString("base64") }));
          socket.send(JSON.stringify({ isFinal: true }), () => socket.close(1000, "done"));
        }
      });
    });
    const dir = await tempDir();
    const initial = join(dir, "tts-init.ndjson");
    writeFileSync(initial, JSON.stringify({ type: "send", data: { text: " " } }));
    const input = new PassThrough();

    const result = await runWs(
      {
        target: "tts-realtime",
        duplex: true,
        send: initial,
        out: dir,
        query: { voice_id: "voice-a" },
      },
      {
        baseUrl: httpBase(server.url),
        duplexInput: input,
        duplexEventSink: (line) => {
          const event = JSON.parse(line) as { step?: string };
          if (event.step === "text") {
            input.write(`${JSON.stringify({ type: "send", data: { text: "Hello " } })}\n`);
          } else if (event.step === "eos") {
            input.write(`${JSON.stringify({ type: "send", data: { text: "" } })}\n`);
          }
        },
        timeoutMs: 500,
      },
    );
    input.destroy();

    expect(result.exitCode).toBe(0);
    expect(server.received.map((raw) => JSON.parse(raw))).toEqual([
      { text: " " },
      { text: "Hello " },
      { text: "" },
    ]);
    expect(readFileSync(join(dir, "audio.mp3"), "utf8")).toBe("tts-live");
  });

  it("rejects incremental single-context TTS after empty-text termination", async () => {
    const server = await startServer((socket, received) => {
      socket.send(JSON.stringify({ type: "next", step: "handshake" }));
      socket.on("message", () => {
        const message = JSON.parse(received.at(-1)!) as { text?: unknown };
        if (message.text === " ") {
          socket.send(JSON.stringify({ type: "next", step: "eos" }));
        } else if (message.text === "") {
          socket.send(JSON.stringify({ type: "next", step: "late" }));
        } else {
          socket.close(1000, "unexpected late message");
        }
      });
    });
    const dir = await tempDir();
    const input = new PassThrough();
    const actions: Record<string, Record<string, unknown>> = {
      handshake: { text: " " },
      eos: { text: "" },
      late: { text: "must not send" },
    };

    const result = await runWs(
      {
        target: "tts-realtime",
        duplex: true,
        out: dir,
        query: { voice_id: "voice-a" },
      },
      {
        baseUrl: httpBase(server.url),
        duplexInput: input,
        duplexEventSink: (line) => {
          const event = JSON.parse(line) as { step?: string };
          const data = event.step ? actions[event.step] : undefined;
          if (data) input.write(`${JSON.stringify({ type: "send", data })}\n`);
        },
        timeoutMs: 500,
      },
    );
    input.destroy();

    expect(result.exitCode).toBe(2);
    expect(result.env.ok ? undefined : result.env.error.code).toBe("ws_duplex_invalid_action");
    expect(result.env.ok ? undefined : result.env.error.message).toContain("closed");
    expect(server.received.map((raw) => JSON.parse(raw))).toEqual([{ text: " " }, { text: "" }]);
    expect(result.env.files?.every((file) => file.partial)).toBe(true);
  });

  it("keeps multi-context TTS open after empty-text keepalive and supports context reuse", async () => {
    const actions = [
      { text: " ", context_id: "a" },
      { text: "", context_id: "a" },
      { text: "after keepalive ", context_id: "a" },
      { context_id: "a", flush: true },
      { context_id: "a", close_context: true },
      { text: "reused ", context_id: "a" },
      { close_socket: true },
    ];
    const server = await startServer((socket, received) => {
      socket.send(JSON.stringify({ type: "next", index: 0 }));
      socket.on("message", () => {
        const index = received.length;
        if (index === actions.length) {
          socket.send(
            JSON.stringify({
              audio: Buffer.from("tts-multi-live").toString("base64"),
              contextId: "a",
            }),
          );
          socket.send(JSON.stringify({ isFinal: true, contextId: "a" }), () =>
            socket.close(1000, "done"),
          );
        } else {
          socket.send(JSON.stringify({ type: "next", index }));
        }
      });
    });
    const dir = await tempDir();
    const input = new PassThrough();

    const result = await runWs(
      {
        target: "tts-multi",
        duplex: true,
        out: dir,
        query: { voice_id: "voice-a" },
      },
      {
        baseUrl: httpBase(server.url),
        duplexInput: input,
        duplexEventSink: (line) => {
          const event = JSON.parse(line) as { index?: number };
          if (event.index !== undefined && actions[event.index]) {
            input.write(`${JSON.stringify({ type: "send", data: actions[event.index] })}\n`);
          }
        },
        timeoutMs: 500,
      },
    );
    input.destroy();

    expect(result.exitCode).toBe(0);
    expect(server.received.map((raw) => JSON.parse(raw))).toEqual(actions);
    const audio = result.env.files?.find((file) => file.path.includes("audio.context-"));
    expect(audio && readFileSync(audio.path, "utf8")).toBe("tts-multi-live");
  });

  it("streams incremental multi-context TTD lifecycle actions", async () => {
    const server = await startServer((socket, received) => {
      socket.send(JSON.stringify({ type: "next", step: "init-a" }));
      socket.on("message", () => {
        const message = JSON.parse(received.at(-1)!) as Record<string, unknown>;
        const step =
          Array.isArray(message.voices) && message.context_id === "a"
            ? message.voices[0] === "voice-a"
              ? "input-a"
              : "input-b"
            : Array.isArray(message.inputs)
              ? message.context_id === "a" && message.close_context !== true
                ? message.inputs.some(
                    (item) =>
                      typeof item === "object" &&
                      item !== null &&
                      (item as Record<string, unknown>).voice_id === "voice-a",
                  )
                  ? "close-a"
                  : "close-socket"
                : "close-socket"
              : message.close_context === true
                ? "init-b"
                : undefined;
        if (message.close_socket === true) {
          socket.send(
            JSON.stringify({
              audio: Buffer.from("ttd-live").toString("base64"),
              context_id: "a",
            }),
          );
          socket.send(JSON.stringify({ is_final: true, context_id: "a" }), () =>
            socket.close(1000, "done"),
          );
        } else if (step) {
          socket.send(JSON.stringify({ type: "next", step }));
        }
      });
    });
    const dir = await tempDir();
    const input = new PassThrough();
    const actions: Record<string, unknown> = {
      "init-a": { context_id: "a", voices: ["voice-a"] },
      "input-a": { context_id: "a", inputs: [{ text: "One", voice_id: "voice-a" }] },
      "close-a": { context_id: "a", close_context: true },
      "init-b": { context_id: "a", voices: ["voice-b"] },
      "input-b": { context_id: "a", inputs: [{ text: "Two", voice_id: "voice-b" }] },
      "close-socket": { close_socket: true },
    };

    const result = await runWs(
      { target: "ttd-multi", duplex: true, out: dir, query: {} },
      {
        baseUrl: httpBase(server.url),
        duplexInput: input,
        duplexEventSink: (line) => {
          const event = JSON.parse(line) as { step?: string };
          const data = event.step ? actions[event.step] : undefined;
          if (data) input.write(`${JSON.stringify({ type: "send", data })}\n`);
        },
        timeoutMs: 500,
      },
    );
    input.destroy();

    expect(result.exitCode).toBe(0);
    expect(server.received.map((raw) => JSON.parse(raw))).toEqual(Object.values(actions));
    const audio = result.env.files?.find((file) => file.path.includes("audio.context-"));
    expect(audio && readFileSync(audio.path, "utf8")).toBe("ttd-live");
  });

  it("streams a file-backed STT chunk and receives its transcript", async () => {
    const audioBytes = Buffer.from([0, 1, 2, 3, 255]);
    let received: Record<string, unknown> | undefined;
    const server = await startServer((socket) => {
      socket.send(JSON.stringify({ type: "ready" }));
      socket.on("message", (data) => {
        received = JSON.parse(data.toString()) as Record<string, unknown>;
        socket.send(JSON.stringify({ message_type: "committed_transcript", text: "heard" }), () =>
          socket.close(1000, "done"),
        );
      });
    });
    const dir = await tempDir();
    const audioPath = join(dir, "live.pcm");
    writeFileSync(audioPath, audioBytes);
    const input = new PassThrough();
    const observed: string[] = [];

    const result = await runWs(
      { target: "stt-realtime", duplex: true, out: dir, query: {} },
      {
        baseUrl: httpBase(server.url),
        duplexInput: input,
        duplexEventSink: (line) => {
          observed.push(line);
          const event = JSON.parse(line) as { type?: string };
          if (event.type === "ready") {
            input.write(
              `${JSON.stringify({
                type: "send_audio_file",
                path: audioPath,
                sample_rate: 16_000,
                commit: true,
              })}\n`,
            );
          }
        },
        timeoutMs: 500,
      },
    );
    input.destroy();

    expect(result.exitCode).toBe(0);
    expect(received).toEqual({
      message_type: "input_audio_chunk",
      audio_base_64: audioBytes.toString("base64"),
      commit: true,
      sample_rate: 16_000,
    });
    expect(observed.join("\n")).toContain("committed_transcript");
  });

  it("streams an empty-base64 STT commit-only chunk", async () => {
    let received: Record<string, unknown> | undefined;
    const server = await startServer((socket) => {
      socket.send(JSON.stringify({ type: "ready" }));
      socket.on("message", (data) => {
        received = JSON.parse(data.toString()) as Record<string, unknown>;
        socket.send(JSON.stringify({ message_type: "committed_transcript", text: "" }), () =>
          socket.close(1000, "done"),
        );
      });
    });
    const dir = await tempDir();
    const input = new PassThrough();
    const commitOnly = {
      message_type: "input_audio_chunk",
      audio_base_64: "",
      commit: true,
      sample_rate: 16_000,
    };

    const result = await runWs(
      { target: "stt-realtime", duplex: true, out: dir, query: {} },
      {
        baseUrl: httpBase(server.url),
        duplexInput: input,
        duplexEventSink: (line) => {
          const event = JSON.parse(line) as { type?: string };
          if (event.type === "ready") {
            input.write(`${JSON.stringify({ type: "send", data: commitOnly })}\n`);
          }
        },
        timeoutMs: 500,
      },
    );
    input.destroy();

    expect(result.exitCode).toBe(0);
    expect(received).toEqual(commitOnly);
  });

  it.each([
    ["TTS", "tts-realtime", { voice_id: "voice-a" }, { text: "not a handshake" }],
    ["TTD", "ttd-realtime", {}, { inputs: [{ text: "Hello", voice_id: "voice-a" }] }],
  ])(
    "rejects an invalid first incremental %s message with partial evidence",
    async (_label, target, query, data) => {
      const server = await startServer((socket) => {
        socket.send(JSON.stringify({ type: "ready", token: "SERVER_SECRET" }));
      });
      const dir = await tempDir();
      const input = new PassThrough();

      const result = await runWs(
        { target, duplex: true, out: dir, query },
        {
          baseUrl: httpBase(server.url),
          duplexInput: input,
          duplexEventSink: (line) => {
            const event = JSON.parse(line) as { type?: string };
            if (event.type === "ready") {
              input.write(`${JSON.stringify({ type: "send", data })}\n`);
            }
          },
          timeoutMs: 500,
        },
      );
      input.destroy();

      expect(result.exitCode).toBe(2);
      expect(result.env.ok).toBe(false);
      if (result.env.ok) throw new Error("expected incremental validation failure");
      expect(result.env.error.code).toBe("ws_duplex_invalid_action");
      expect(result.env.files?.every((file) => file.partial)).toBe(true);
      const filesText = (result.env.files ?? [])
        .map((file) => readFileSync(file.path, "utf8"))
        .join("\n");
      expect(filesText).toContain("ready");
      expect(filesText).not.toContain("SERVER_SECRET");
    },
  );

  it("seeds incremental validation from the initial script and rejects actions after close", async () => {
    const server = await startServer((socket) => {
      socket.send(JSON.stringify({ type: "ready" }));
    });
    const dir = await tempDir();
    const initial = join(dir, "closed-ttd.ndjson");
    writeFileSync(
      initial,
      [
        { type: "send", data: { voices: ["voice-a"] } },
        { type: "send", data: { close_socket: true } },
      ]
        .map((action) => JSON.stringify(action))
        .join("\n"),
    );
    const input = new PassThrough();

    const result = await runWs(
      { target: "ttd-realtime", duplex: true, send: initial, out: dir, query: {} },
      {
        baseUrl: httpBase(server.url),
        duplexInput: input,
        duplexEventSink: () => {
          input.write(
            `${JSON.stringify({
              type: "send",
              data: { inputs: [{ text: "too late", voice_id: "voice-a" }] },
            })}\n`,
          );
        },
        timeoutMs: 500,
      },
    );
    input.destroy();

    expect(result.exitCode).toBe(2);
    expect(result.env.ok ? undefined : result.env.error.code).toBe("ws_duplex_invalid_action");
    expect(result.env.ok ? undefined : result.env.error.message).toContain("closed");
  });

  it("enforces the five-context limit across incremental TTD messages", async () => {
    const server = await startServer((socket) => {
      socket.send(JSON.stringify({ type: "ready" }));
    });
    const dir = await tempDir();
    const input = new PassThrough();

    const result = await runWs(
      { target: "ttd-multi", duplex: true, out: dir, query: {} },
      {
        baseUrl: httpBase(server.url),
        duplexInput: input,
        duplexEventSink: () => {
          for (let index = 1; index <= 6; index += 1) {
            input.write(
              `${JSON.stringify({
                type: "send",
                data: { context_id: String(index), voices: [`voice-${index}`] },
              })}\n`,
            );
          }
        },
        timeoutMs: 500,
      },
    );
    input.destroy();

    expect(result.exitCode).toBe(2);
    expect(result.env.ok ? undefined : result.env.error.code).toBe("ws_duplex_invalid_action");
    expect(result.env.ok ? undefined : result.env.error.message).toContain("5 simultaneous");
    expect(server.received).toHaveLength(5);
  });

  it.each([
    ["tts-realtime", { voice_id: "voice-a" }],
    ["ttd-realtime", {}],
    ["ttd-multi", {}],
    ["stt-realtime", {}],
  ])("fails closed on a configured ceiling for dynamic %s", async (target, query) => {
    const server = await startServer(() => undefined);
    const dir = await tempDir();
    const input = new PassThrough();
    const result = await runWs(
      { target, duplex: true, out: dir, query },
      {
        baseUrl: httpBase(server.url),
        duplexInput: input,
        maxCredits: 10,
        yes: true,
        timeoutMs: 100,
      },
    );
    input.destroy();

    expect(result.exitCode).toBe(5);
    expect(result.env.ok ? undefined : result.env.error.code).toBe("budget_estimate_unavailable");
    expect(server.connected).toBe(false);
  });

  it("dry-runs dynamic synthesis without reading stdin or connecting", async () => {
    const server = await startServer(() => undefined);
    const dir = await tempDir();
    const input = new PassThrough();
    input.end("{invalid live input}\n");

    const result = await runWs(
      {
        target: "tts-realtime",
        duplex: true,
        out: dir,
        query: { voice_id: "voice-a" },
      },
      {
        baseUrl: httpBase(server.url),
        duplexInput: input,
        dryRun: true,
        maxCredits: 10,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(server.connected).toBe(false);
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("readable")).toBe(0);
    const serialized = JSON.stringify(result.env);
    expect(serialized).toContain('"credits_estimated":null');
    expect(serialized).toContain('"budget_policy":"estimate_unavailable"');
    expect(serialized).toContain('"dynamic_cost_unbounded":true');
  });

  it("fails closed when a ceiling is configured for a duplex agent session", async () => {
    const server = await startServer(() => undefined);
    const dir = await tempDir();
    const input = new PassThrough();
    const result = await runWs(
      { target: "convai", duplex: true, out: dir, query: { agent_id: "agent-1" } },
      {
        baseUrl: httpBase(server.url),
        duplexInput: input,
        maxCredits: 10,
        yes: true,
        timeoutMs: 100,
      },
    );
    input.destroy();

    expect(result.exitCode).toBe(5);
    expect(result.env.ok ? undefined : result.env.error.code).toBe("budget_estimate_unavailable");
    expect(server.connected).toBe(false);
  });

  it.each([
    ["invalid JSON", "{broken", "ws_duplex_invalid_json"],
    ["unsupported action", JSON.stringify({ type: "wait" }), "ws_duplex_invalid_action"],
    ["oversized line", "x".repeat(1024 * 1024 + 1), "ws_duplex_line_too_large"],
  ])("returns a typed duplex input error for %s", async (_label, line, code) => {
    const server = await startServer(() => undefined);
    const dir = await tempDir();
    const input = new PassThrough();
    input.end(`${line}\n`);

    const result = await runWs(
      { target: server.url, duplex: true, out: dir, query: {} },
      { duplexInput: input, duplexEventSink: () => undefined, timeoutMs: 500 },
    );

    expect(result.exitCode).toBe(2);
    expect(result.env.ok).toBe(false);
    if (result.env.ok) throw new Error("expected duplex failure");
    expect(result.env.error.type).toBe("validation_error");
    expect(result.env.error.code).toBe(code);
  });

  it("accepts an explicit close after a terminal duplex message", async () => {
    const server = await startServer(() => undefined);
    const dir = await tempDir();
    const initial = join(dir, "tts-init.ndjson");
    writeFileSync(initial, JSON.stringify({ type: "send", data: { text: " " } }));
    const input = new PassThrough();
    input.write(`${JSON.stringify({ type: "send", data: { text: "bye" } })}\n`);
    input.write(`${JSON.stringify({ type: "send", data: { text: "" } })}\n`);
    input.write(`${JSON.stringify({ type: "close" })}\n`);

    const result = await runWs(
      {
        target: "tts-realtime",
        duplex: true,
        send: initial,
        out: dir,
        query: { voice_id: "voice-a" },
      },
      {
        baseUrl: httpBase(server.url),
        duplexInput: input,
        duplexEventSink: () => undefined,
        timeoutMs: 500,
      },
    );
    input.destroy();

    expect(result.exitCode).toBe(0);
    expect(server.received.map((raw) => JSON.parse(raw))).toEqual([
      { text: " " },
      { text: "bye" },
      { text: "" },
    ]);
  });

  it("rejects a close action in a duplex seed script", async () => {
    const server = await startServer(() => undefined);
    const dir = await tempDir();
    const seed = join(dir, "seed.ndjson");
    writeFileSync(
      seed,
      [{ type: "send", data: { text: " " } }, { type: "close" }]
        .map((line) => JSON.stringify(line))
        .join("\n"),
    );
    const input = new PassThrough();

    const result = await runWs(
      {
        target: "tts-realtime",
        duplex: true,
        send: seed,
        out: dir,
        query: { voice_id: "voice-a" },
      },
      {
        baseUrl: httpBase(server.url),
        duplexInput: input,
        duplexEventSink: () => undefined,
        timeoutMs: 500,
      },
    );
    input.destroy();

    expect(result.exitCode).toBe(2);
    expect(result.env.ok ? undefined : result.env.error.message).toContain("--duplex");
    expect(server.connected).toBe(false);
  });

  it("reports a duplex input error the remote close would otherwise mask", async () => {
    const input = new PassThrough();
    input.write(`${JSON.stringify({ type: "wait" })}\n`);
    const reader = new DuplexActionReader(input, "raw", []);
    // Let readline queue the invalid line before the race starts, so the reader rejects
    // after an already-resolved close has won: the polarity finding 7 is about.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const state: WsSessionState = {
      eventsSent: 0,
      eventsReceived: 0,
      closed: true,
      opened: true,
      messageChain: Promise.resolve(),
      binaryPaths: [],
    };
    // The invalid line throws before any action is sent, so the socket is never touched.
    const socket = { readyState: WebSocket.CLOSED } as unknown as WebSocket;

    await expect(runDuplexSession(socket, state, Promise.resolve(), reader)).rejects.toThrow(
      /unsupported send-script action/u,
    );
    input.destroy();
  });

  it("emits a duplex event for a received binary frame", async () => {
    const server = await startServer((socket) => {
      socket.send(Buffer.from("binary-payload"), { binary: true }, () =>
        socket.close(1000, "done"),
      );
    });
    const dir = await tempDir();
    const input = new PassThrough();
    const events: string[] = [];

    const result = await runWs(
      { target: server.url, duplex: true, out: dir, query: {} },
      {
        duplexInput: input,
        duplexEventSink: (line) => events.push(line),
        timeoutMs: 500,
      },
    );
    input.destroy();

    expect(result.exitCode).toBe(0);
    const binaryEvents = events
      .map((line) => JSON.parse(line) as { type?: string; bytes?: number; path?: string })
      .filter((event) => event.type === "binary");
    expect(binaryEvents).toHaveLength(1);
    expect(binaryEvents[0]?.bytes).toBe("binary-payload".length);
    expect(readFileSync(binaryEvents[0]!.path!, "utf8")).toBe("binary-payload");
  });

  it("closes a duplex socket cleanly on input EOF", async () => {
    let clientClosed = false;
    const server = await startServer((socket) => {
      socket.on("close", () => {
        clientClosed = true;
      });
    });
    const dir = await tempDir();
    const input = new PassThrough();
    input.end();

    const result = await runWs(
      { target: server.url, duplex: true, out: dir, query: {} },
      { duplexInput: input, duplexEventSink: () => undefined, timeoutMs: 500 },
    );

    expect(result.exitCode).toBe(0);
    expect(clientClosed).toBe(true);
  });

  it("stops its duplex reader after remote close and timeout", async () => {
    const closingServer = await startServer((socket) => {
      socket.send(JSON.stringify({ type: "notice", text: "done" }), () =>
        socket.close(1000, "done"),
      );
    });
    const dir = await tempDir();
    const remoteInput = new PassThrough();
    const remoteResult = await runWs(
      { target: closingServer.url, duplex: true, out: dir, query: {} },
      { duplexInput: remoteInput, duplexEventSink: () => undefined, timeoutMs: 500 },
    );
    expect(remoteResult.exitCode).toBe(0);
    expect(remoteInput.listenerCount("data")).toBe(0);
    expect(remoteInput.listenerCount("readable")).toBe(0);
    remoteInput.destroy();

    const idleServer = await startServer(() => undefined);
    const timeoutInput = new PassThrough();
    const timeoutResult = await runWs(
      { target: idleServer.url, duplex: true, out: dir, query: {} },
      { duplexInput: timeoutInput, duplexEventSink: () => undefined, timeoutMs: 25 },
    );
    expect(timeoutResult.exitCode).toBe(8);
    expect(timeoutResult.env.ok ? undefined : timeoutResult.env.error.code).toBe(
      "ws_inactivity_timeout",
    );
    expect(timeoutInput.listenerCount("data")).toBe(0);
    expect(timeoutInput.listenerCount("readable")).toBe(0);
    timeoutInput.destroy();
  });

  it("preserves received files when a duplex provider message fails", async () => {
    const server = await startServer((socket) => {
      socket.send(JSON.stringify({ type: "notice", text: "keep me" }));
      socket.send("{broken");
    });
    const dir = await tempDir();
    const input = new PassThrough();

    const result = await runWs(
      { target: server.url, duplex: true, out: dir, query: {} },
      { duplexInput: input, duplexEventSink: () => undefined, timeoutMs: 500 },
    );
    input.destroy();

    expect(result.exitCode).toBe(8);
    expect(result.env.ok).toBe(false);
    if (result.env.ok) throw new Error("expected provider failure");
    expect(result.env.error.code).toBe("ws_session_failed");
    expect(result.env.files?.every((file) => file.partial)).toBe(true);
    const events = result.env.files?.find((file) => file.path.includes("events.received"));
    expect(events && readFileSync(events.path, "utf8")).toContain("keep me");
  });

  it("rejects missing auth environment values before connecting", async () => {
    const server = await startServer(() => undefined);
    const dir = await tempDir();
    const script = join(dir, "script.ndjson");
    writeFileSync(script, JSON.stringify({ type: "send", data: { text: " " } }));
    delete process.env.ELV_TEST_MISSING_WS_AUTH;

    const tokenResult = await runWs(
      {
        target: "tts-realtime",
        tokenEnv: "ELV_TEST_MISSING_WS_AUTH",
        send: script,
        out: dir,
        query: { voice_id: "voice-a" },
      },
      { baseUrl: httpBase(server.url), timeoutMs: 100 },
    );
    expect(tokenResult.exitCode).toBe(2);
    expect(server.connected).toBe(false);

    const urlResult = await runWs(
      { urlEnv: "ELV_TEST_MISSING_WS_AUTH", send: script, out: dir, query: {} },
      { timeoutMs: 100 },
    );
    expect(urlResult.exitCode).toBe(2);
    expect(server.connected).toBe(false);
  });

  it("fails closed before realtime STT or agent sessions when a ceiling cannot be bounded", async () => {
    const server = await startServer(() => undefined);
    const dir = await tempDir();
    const script = join(dir, "script.ndjson");
    writeFileSync(
      script,
      JSON.stringify({
        type: "send",
        data: {
          message_type: "input_audio_chunk",
          audio_base_64: "YXVkaW8=",
          commit: true,
          sample_rate: 16_000,
        },
      }),
    );

    const result = await runWs(
      { target: "stt-realtime", send: script, out: dir, query: {} },
      { baseUrl: httpBase(server.url), maxCredits: 10, timeoutMs: 100 },
    );

    expect(result.exitCode).toBe(5);
    expect(result.env.ok).toBe(false);
    expect(result.env.ok ? undefined : result.env.error.code).toBe("budget_estimate_unavailable");
    expect(server.connected).toBe(false);
  });

  it("inherits realtime STT budget gates for configured-host raw paths", async () => {
    const server = await startServer(() => undefined);
    const dir = await tempDir();
    const script = join(dir, "script.ndjson");
    writeFileSync(
      script,
      JSON.stringify({
        type: "send",
        data: {
          message_type: "input_audio_chunk",
          audio_base_64: "YXVkaW8=",
          commit: true,
          sample_rate: 16_000,
        },
      }),
    );

    const result = await runWs(
      { target: "/v1/speech-to-text/realtime", send: script, out: dir, query: {} },
      { baseUrl: httpBase(server.url), maxCredits: 10, timeoutMs: 100 },
    );

    expect(result.exitCode).toBe(5);
    expect(result.env.ok).toBe(false);
    expect(result.env.ok ? undefined : result.env.error.code).toBe("budget_estimate_unavailable");
    expect(server.connected).toBe(false);
  });

  it("estimates catalog TTS text before connecting", async () => {
    const server = await startServer(() => undefined);
    const dir = await tempDir();
    const script = join(dir, "script.ndjson");
    writeFileSync(
      script,
      [
        { type: "send", data: { text: " " } },
        { type: "send", data: { text: "This exceeds one credit." } },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
    );

    const result = await runWs(
      {
        target: "tts-realtime",
        send: script,
        out: dir,
        query: { voice_id: "v1", model_id: "eleven_multilingual_v2" },
      },
      { baseUrl: httpBase(server.url), maxCredits: 1, timeoutMs: 100 },
    );

    expect(result.exitCode).toBe(5);
    expect(result.env.ok).toBe(false);
    expect(server.connected).toBe(false);
  });

  it("allows configured-host raw paths to use profile authentication", async () => {
    const server = await startServer((socket) => {
      socket.on("message", () => socket.close(1000, "done"));
    });
    const dir = await tempDir();
    const script = join(dir, "script.ndjson");
    writeFileSync(script, JSON.stringify({ type: "send", data: { hello: "world" } }));

    const result = await runWs(
      { target: "/v1/custom/socket", send: script, out: dir, query: {} },
      { baseUrl: httpBase(server.url), apiKey: "sk_profile", timeoutMs: 500 },
    );

    expect(result.exitCode).toBe(0);
    expect(server.headers["xi-api-key"]).toBe("sk_profile");
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

  it("bounds the WebSocket handshake with the configured timeout", async () => {
    const connections = new Set<Socket>();
    const blackhole = createTcpServer((socket) => {
      connections.add(socket);
      socket.once("close", () => connections.delete(socket));
    });
    await new Promise<void>((resolve) => blackhole.listen(0, "127.0.0.1", resolve));
    const address = blackhole.address();
    if (!address || typeof address === "string") throw new Error("missing TCP server address");
    const dir = await tempDir();
    const script = join(dir, "script.ndjson");
    writeFileSync(script, JSON.stringify({ type: "send", data: { text: " " } }));

    try {
      const result = await runWs(
        {
          target: `ws://127.0.0.1:${address.port}/never-upgrades`,
          send: script,
          out: dir,
          query: {},
        },
        { timeoutMs: 25 },
      );

      expect(result.exitCode).toBe(8);
      expect(result.env.ok).toBe(false);
      if (result.env.ok) throw new Error("expected connect timeout");
      expect(result.env.error.code).toBe("ws_connect_timeout");
      expect(result.env.ws).toMatchObject({ timed_out: true });
      expect(result.env.ws).not.toHaveProperty("partial");
      expect(result.env.files).toBeUndefined();
    } finally {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        blackhole.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("reports inactivity timeout as a non-successful partial session", async () => {
    const server = await startServer(() => undefined);
    const dir = await tempDir();
    const script = join(dir, "script.ndjson");
    writeFileSync(script, JSON.stringify({ type: "send", data: { text: " " } }));

    const result = await runWs(
      { target: server.url, send: script, out: dir, query: {} },
      { timeoutMs: 25 },
    );

    expect(result.exitCode).toBe(8);
    expect(result.env.ok).toBe(false);
    if (result.env.ok) throw new Error("expected inactivity timeout");
    expect(result.env.error.code).toBe("ws_inactivity_timeout");
    expect(result.env.ws).toMatchObject({ timed_out: true, closed: true });
  });

  it("rejects invalid base64 and preserves prior event, audio, and binary files", async () => {
    const server = await startServer((socket) => {
      socket.send(Buffer.from([0, 1, 2]), { binary: true });
      socket.send(JSON.stringify({ audio: Buffer.from("kept").toString("base64") }));
      socket.send(JSON.stringify({ audio: "not!!valid" }));
    });
    const dir = await tempDir();
    const script = join(dir, "script.ndjson");
    writeFileSync(script, JSON.stringify({ type: "send", data: { text: " " } }));

    const result = await runWs(
      { target: server.url, send: script, out: dir, query: {} },
      { timeoutMs: 500 },
    );

    expect(result.exitCode).toBe(8);
    expect(result.env.ok).toBe(false);
    if (result.env.ok) throw new Error("expected session failure");
    expect(result.env.error).toMatchObject({
      code: "ws_session_failed",
      message: "Invalid base64 audio in WebSocket event",
      raw: { partial: true },
    });
    expect(result.env.ws).toMatchObject({ partial: true, timed_out: false });
    expect(result.env.files?.every((file) => file.partial)).toBe(true);
    const audio = result.env.files?.find((file) => file.path.includes("audio."));
    const binary = result.env.files?.find((file) => file.path.includes("binary.received"));
    const events = result.env.files?.find((file) => file.path.includes("events.received"));
    expect(audio && readFileSync(audio.path, "utf8")).toBe("kept");
    expect(binary && readFileSync(binary.path)).toEqual(Buffer.from([0, 1, 2]));
    expect(events && readFileSync(events.path, "utf8")).toContain("not!!valid");
    expect(result.env.hints?.[0]?.why).toContain("credits may already have been consumed");
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
  requestUrl: string | undefined;
}> {
  const server = new WebSocketServer({ port: 0 });
  servers.push(server);
  const received: string[] = [];
  let connected = false;
  let headers: IncomingHttpHeaders = {};
  let requestUrl: string | undefined;
  server.on("connection", (socket, request) => {
    connected = true;
    headers = request.headers;
    requestUrl = request.url;
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
    get requestUrl() {
      return requestUrl;
    },
    received,
    url: `ws://127.0.0.1:${address.port}/session?single_use_token=tok_secret`,
  };
}

function closeServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function httpBase(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.protocol = "http:";
  url.pathname = "/";
  url.search = "";
  return url.toString();
}
