import WebSocket, { type RawData } from "ws";
import { mkdir } from "node:fs/promises";
import { fileRecord, writeManifest } from "../core/files";
import { AudioWriter } from "./audio-writer";
import { NdjsonEventWriter, redactWs, redactWsString } from "./events";
import type { FileRecord, WsInfo } from "../core/types";
import type { SendScriptAction } from "./events";

export interface WsSessionOptions {
  url: URL;
  catalog: string | null;
  path: string;
  outDir: string;
  script: SendScriptAction[];
  headers?: Record<string, string>;
  timeoutMs?: number;
  outputFormat?: string;
}

export interface WsSessionResult {
  ws: WsInfo;
  files: FileRecord[];
}

export async function runWsSession(options: WsSessionOptions): Promise<WsSessionResult> {
  await mkdir(options.outDir, { recursive: true });
  const events = new NdjsonEventWriter(options.outDir);
  const audio = new AudioWriter(options.outDir, options.outputFormat);
  const socket = new WebSocket(options.url, { headers: options.headers });
  const timeoutMs = options.timeoutMs ?? 20_000;
  let eventsSent = 0;
  let eventsReceived = 0;
  let closed = false;
  let opened = false;
  let messageChain = Promise.resolve();
  const inactivity = createInactivityTimer(socket, timeoutMs);

  try {
    const closedPromise = new Promise<void>((resolve, reject) => {
      socket.once("close", () => {
        closed = true;
        resolve();
      });
      socket.once("error", (error) => {
        if (opened) reject(error);
      });
    });

    socket.on("message", (data) => {
      messageChain = messageChain.then(async () => {
        inactivity.reset();
        eventsReceived += 1;
        await processMessage(data, socket, events, audio);
      });
    });

    await new Promise<void>((resolve, reject) => {
      const failBeforeOpen = (error: Error): void => reject(error);
      socket.once("open", () => {
        opened = true;
        socket.off("error", failBeforeOpen);
        resolve();
      });
      socket.once("error", failBeforeOpen);
    });

    inactivity.reset();
    await playScript(socket, options.script, () => {
      eventsSent += 1;
    });

    await closedPromise;

    inactivity.clear();
    await messageChain;
    const files: FileRecord[] = [];
    const eventPath = await events.close();
    files.push(await fileRecord(eventPath, { hash: true }));
    const audioPath = await audio.close();
    if (audioPath) files.push(await fileRecord(audioPath, { hash: true }));
    const manifestPath = await writeManifest(
      options.outDir,
      redactWs({
        catalog: options.catalog,
        path: options.path,
        connection_url: redactWsString(options.url.toString()),
        headers: options.headers ?? {},
        events_sent: eventsSent,
        events_received: eventsReceived,
        closed,
        timed_out: inactivity.timedOut(),
      }),
    );
    files.push(await fileRecord(manifestPath, { hash: true }));

    return {
      ws: {
        catalog: options.catalog,
        path: options.path,
        events_sent: eventsSent,
        events_received: eventsReceived,
        closed,
      },
      files,
    };
  } catch (error) {
    inactivity.clear();
    await Promise.allSettled([events.abort(), audio.abort()]);
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
      socket.terminate();
    throw error;
  }
}

function createInactivityTimer(
  socket: WebSocket,
  timeoutMs: number,
): {
  reset: () => void;
  clear: () => void;
  timedOut: () => boolean;
} {
  let timer: NodeJS.Timeout | undefined;
  let didTimeOut = false;
  const clear = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return {
    reset: () => {
      clear();
      timer = setTimeout(() => {
        didTimeOut = true;
        if (socket.readyState === WebSocket.OPEN) socket.close();
        setTimeout(() => {
          if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
        }, 100).unref();
      }, timeoutMs);
      timer.unref();
    },
    clear,
    timedOut: () => didTimeOut,
  };
}

async function processMessage(
  data: RawData,
  socket: WebSocket,
  events: NdjsonEventWriter,
  audio: AudioWriter,
): Promise<void> {
  const raw = rawDataToString(data);
  await events.writeRaw(raw);
  const parsed = parseJson(raw);
  await audio.writeFromEvent(parsed);
  if (isPing(parsed) && socket.readyState === WebSocket.OPEN) {
    await sendJson(socket, { type: "pong", event_id: parsed.event_id });
  }
}

async function playScript(
  socket: WebSocket,
  script: SendScriptAction[],
  onSent: () => void,
): Promise<void> {
  for (const action of script) {
    if (action.type === "close") break;
    if (socket.readyState !== WebSocket.OPEN) break;
    await sendJson(socket, action.data);
    onSent();
  }
}

function sendJson(socket: WebSocket, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(JSON.stringify(value), (error) => (error ? reject(error) : resolve()));
  });
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function isPing(value: unknown): value is { type: "ping"; event_id?: unknown } {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === "ping",
  );
}
