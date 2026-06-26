import WebSocket, { type RawData } from "ws";
import { mkdir } from "node:fs/promises";
import { fileRecord, writeManifest } from "../core/files";
import { AudioWriter } from "./audio-writer";
import { NdjsonEventWriter, redactWs, redactWsString } from "./events";
import { parseJson as parseJsonValue } from "../util/json";
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

interface WsSessionState {
  eventsSent: number;
  eventsReceived: number;
  closed: boolean;
  opened: boolean;
  messageChain: Promise<void>;
}

export async function runWsSession(options: WsSessionOptions): Promise<WsSessionResult> {
  await mkdir(options.outDir, { recursive: true });
  const events = new NdjsonEventWriter(options.outDir);
  const audio = new AudioWriter(options.outDir, options.outputFormat);
  const socket = new WebSocket(options.url, { headers: options.headers });
  const timeoutMs = options.timeoutMs ?? 20_000;
  const state: WsSessionState = {
    eventsSent: 0,
    eventsReceived: 0,
    closed: false,
    opened: false,
    messageChain: Promise.resolve(),
  };
  const inactivity = createInactivityTimer(socket, timeoutMs);

  try {
    const closedPromise = waitForClose(socket, state);
    trackMessages(socket, state, inactivity, events, audio);
    await waitForOpen(socket, state);

    inactivity.reset();
    state.eventsSent = await playScript(socket, options.script);

    await closedPromise;

    inactivity.clear();
    await state.messageChain;
    return await finishSession(options, state, events, audio, inactivity);
  } catch (error) {
    await abortSession(socket, events, audio, inactivity);
    throw error;
  }
}

function waitForClose(socket: WebSocket, state: WsSessionState): Promise<void> {
  return new Promise(waitForCloseExecutor.bind(null, socket, state));
}

function waitForCloseExecutor(
  socket: WebSocket,
  state: WsSessionState,
  resolve: () => void,
  reject: (error: Error) => void,
): void {
  socket.once("close", markClosed.bind(null, state, resolve));
  socket.once("error", handleCloseError.bind(null, state, reject));
}

function markClosed(state: WsSessionState, resolve: () => void): void {
  state.closed = true;
  resolve();
}

function handleCloseError(
  state: WsSessionState,
  reject: (error: Error) => void,
  error: Error,
): void {
  if (state.opened) reject(error);
}

function trackMessages(
  socket: WebSocket,
  state: WsSessionState,
  inactivity: ReturnType<typeof createInactivityTimer>,
  events: NdjsonEventWriter,
  audio: AudioWriter,
): void {
  socket.on("message", (data) => {
    state.messageChain = state.messageChain.then(() =>
      processSessionMessage(data, socket, state, inactivity, events, audio),
    );
  });
}

async function processSessionMessage(
  data: RawData,
  socket: WebSocket,
  state: WsSessionState,
  inactivity: ReturnType<typeof createInactivityTimer>,
  events: NdjsonEventWriter,
  audio: AudioWriter,
): Promise<void> {
  inactivity.reset();
  state.eventsReceived += 1;
  await processMessage(data, socket, events, audio);
}

function waitForOpen(socket: WebSocket, state: WsSessionState): Promise<void> {
  return new Promise((resolve, reject) => {
    const failBeforeOpen = (error: Error): void => reject(error);
    socket.once("open", () => {
      state.opened = true;
      socket.off("error", failBeforeOpen);
      resolve();
    });
    socket.once("error", failBeforeOpen);
  });
}

async function finishSession(
  options: WsSessionOptions,
  state: WsSessionState,
  events: NdjsonEventWriter,
  audio: AudioWriter,
  inactivity: ReturnType<typeof createInactivityTimer>,
): Promise<WsSessionResult> {
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
      events_sent: state.eventsSent,
      events_received: state.eventsReceived,
      closed: state.closed,
      timed_out: inactivity.timedOut(),
    }),
  );
  files.push(await fileRecord(manifestPath, { hash: true }));

  return {
    ws: {
      catalog: options.catalog,
      path: options.path,
      events_sent: state.eventsSent,
      events_received: state.eventsReceived,
      closed: state.closed,
    },
    files,
  };
}

async function abortSession(
  socket: WebSocket,
  events: NdjsonEventWriter,
  audio: AudioWriter,
  inactivity: ReturnType<typeof createInactivityTimer>,
): Promise<void> {
  inactivity.clear();
  await Promise.allSettled([events.abort(), audio.abort()]);
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
    socket.terminate();
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

async function playScript(socket: WebSocket, script: SendScriptAction[]): Promise<number> {
  let eventsSent = 0;
  for (const action of script) {
    if (action.type === "close") break;
    if (socket.readyState !== WebSocket.OPEN) break;
    await sendJson(socket, action.data);
    eventsSent += 1;
  }
  return eventsSent;
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
    return parseJsonValue(raw, "WebSocket message");
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
