import WebSocket, { type RawData } from "ws";
import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { fileRecord, writeBufferToFile, writeManifest } from "../core/files";
import { AudioWriter } from "./audio-writer";
import type { AudioOutput } from "./audio-writer";
import {
  duplexEventLine,
  MAX_BINARY_FILE_BYTES,
  MAX_DUPLEX_LINE_BYTES,
  NdjsonEventWriter,
  parseSendScript,
  redactWs,
  redactWsString,
  validateBinaryFiles,
} from "./events";
import { isRecord, parseJson as parseJsonValue } from "../util/json";
import type { FileRecord, SuccessEnvelope, WsInfo } from "../core/types";
import type { JsonObject, JsonValue } from "../util/json";
import type { SendScriptAction } from "./events";
import type { WsProtocol } from "./catalog";

interface DuplexSessionOptions {
  input: NodeJS.ReadableStream;
  protocol: WsProtocol | "raw";
  onEvent: (line: string) => void;
}

interface WsSessionOptions {
  url: URL;
  catalog: string | null;
  path: string;
  outDir: string;
  script: SendScriptAction[];
  headers?: Record<string, string>;
  timeoutMs?: number;
  outputFormat?: string;
  duplex?: DuplexSessionOptions;
}

type WsSessionResult = Required<Pick<SuccessEnvelope, "ws" | "files">>;

export class WsSessionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly ws: WsInfo,
    readonly files: FileRecord[],
  ) {
    super(message);
    this.name = "WsSessionError";
  }
}

class WsConnectTimeoutError extends Error {}
class WsInactivityTimeoutError extends Error {}
class WsDuplexInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WsDuplexInputError";
  }
}

interface WsSessionState {
  eventsSent: number;
  eventsReceived: number;
  closed: boolean;
  opened: boolean;
  messageChain: Promise<void>;
  binaryPaths: string[];
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
    binaryPaths: [],
  };
  const inactivity = createInactivityTimer(socket, timeoutMs);
  let duplexReader: DuplexActionReader | undefined;

  try {
    const closedPromise = waitForClose(socket, state);
    void closedPromise.catch(() => undefined);
    trackMessages(socket, state, inactivity, events, audio, options.duplex?.onEvent);
    await waitForOpen(socket, state, timeoutMs);

    inactivity.reset();
    state.eventsSent = await playScript(socket, options.script);
    if (options.duplex) {
      duplexReader = new DuplexActionReader(options.duplex.input, options.duplex.protocol);
      await runDuplexSession(socket, state, closedPromise, duplexReader);
    } else {
      await closedPromise;
    }

    inactivity.clear();
    await state.messageChain;
    if (inactivity.timedOut()) throw new WsInactivityTimeoutError();
    return await finishSession(options, state, events, audio, inactivity);
  } catch (error) {
    inactivity.clear();
    terminateSocket(socket);
    await state.messageChain.catch(() => undefined);
    const files = await preserveFailedSession(options, state, events, audio, inactivity);
    const timedOut =
      error instanceof WsConnectTimeoutError || error instanceof WsInactivityTimeoutError;
    const code =
      error instanceof WsConnectTimeoutError
        ? "ws_connect_timeout"
        : error instanceof WsInactivityTimeoutError
          ? "ws_inactivity_timeout"
          : error instanceof WsDuplexInputError
            ? error.code
            : "ws_session_failed";
    const message =
      error instanceof WsConnectTimeoutError
        ? `WebSocket did not open within ${timeoutMs}ms`
        : error instanceof WsInactivityTimeoutError
          ? `WebSocket was inactive for ${timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error);
    throw new WsSessionError(
      code,
      message,
      wsInfo(options, state, timedOut, files.length > 0),
      files,
    );
  } finally {
    duplexReader?.close();
  }
}

function waitForClose(socket: WebSocket, state: WsSessionState): Promise<void> {
  const closed = closeEvent(socket, state);
  const failed = openedErrorEvent(socket, state);
  void closed.catch(() => undefined);
  void failed.catch(() => undefined);
  return Promise.race([closed, failed]).then(() => undefined);
}

async function closeEvent(socket: WebSocket, state: WsSessionState): Promise<void> {
  await once(socket, "close");
  state.closed = true;
}

async function openedErrorEvent(socket: WebSocket, state: WsSessionState): Promise<void> {
  const [error] = (await once(socket, "error")) as [Error];
  if (state.opened) throw error;
}

function trackMessages(
  socket: WebSocket,
  state: WsSessionState,
  inactivity: ReturnType<typeof createInactivityTimer>,
  events: NdjsonEventWriter,
  audio: AudioWriter,
  onDuplexEvent?: (line: string) => void,
): void {
  socket.on("message", (data, isBinary) => {
    state.messageChain = state.messageChain
      .then(() =>
        processSessionMessage(
          data,
          isBinary,
          socket,
          state,
          inactivity,
          events,
          audio,
          onDuplexEvent,
        ),
      )
      .catch((error: unknown) => {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.terminate();
        }
        throw error;
      });
    void state.messageChain.catch(() => undefined);
  });
}

async function processSessionMessage(
  data: RawData,
  isBinary: boolean,
  socket: WebSocket,
  state: WsSessionState,
  inactivity: ReturnType<typeof createInactivityTimer>,
  events: NdjsonEventWriter,
  audio: AudioWriter,
  onDuplexEvent?: (line: string) => void,
): Promise<void> {
  inactivity.reset();
  state.eventsReceived += 1;
  if (isBinary) {
    const path = await writeBinaryFrame(data, events.path, state.binaryPaths.length + 1);
    state.binaryPaths.push(path);
    return;
  }
  await processMessage(data, socket, events, audio, onDuplexEvent);
}

function waitForOpen(socket: WebSocket, state: WsSessionState, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("open", opened);
      socket.off("error", failed);
    };
    const opened = (): void => {
      state.opened = true;
      cleanup();
      resolve();
    };
    const failed = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new WsConnectTimeoutError());
      terminateSocket(socket);
    }, timeoutMs);
    timer.unref();
    socket.once("open", opened);
    socket.once("error", failed);
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
  const audioOutputs = await audio.closeAll();
  for (const output of audioOutputs) files.push(await fileRecord(output.path, { hash: true }));
  for (const path of state.binaryPaths) files.push(await fileRecord(path, { hash: true }));
  const manifestPath = await writeManifest(
    options.outDir,
    sessionManifest(options, state, inactivity, audioOutputs),
  );
  files.push(await fileRecord(manifestPath, { hash: true }));

  return {
    ws: wsInfo(options, state, inactivity.timedOut(), false),
    files,
  };
}

async function preserveFailedSession(
  options: WsSessionOptions,
  state: WsSessionState,
  events: NdjsonEventWriter,
  audio: AudioWriter,
  inactivity: ReturnType<typeof createInactivityTimer>,
): Promise<FileRecord[]> {
  const hasOutput = events.hasData || audio.hasData || state.binaryPaths.length > 0;
  if (!hasOutput) {
    await Promise.allSettled([events.abort(), audio.abort()]);
    return [];
  }

  const paths = [...state.binaryPaths];
  let audioOutputs: AudioOutput[] = [];
  try {
    if (events.hasData) paths.push(await events.close());
    else await events.abort();
  } catch {
    // Preserve every other recoverable session artifact.
  }
  try {
    if (audio.hasData) {
      audioOutputs = await audio.closeAll();
      paths.push(...audioOutputs.map(({ path }) => path));
    } else {
      await audio.abort();
    }
  } catch {
    // Preserve every other recoverable session artifact.
  }
  try {
    paths.push(
      await writeManifest(
        options.outDir,
        sessionManifest(options, state, inactivity, audioOutputs, true),
      ),
    );
  } catch {
    // The received payload files remain recoverable even if the diagnostic manifest cannot be written.
  }
  const records = await Promise.allSettled(
    paths.map(async (path) => ({ ...(await fileRecord(path, { hash: true })), partial: true })),
  );
  return records.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
}

function sessionManifest(
  options: WsSessionOptions,
  state: WsSessionState,
  inactivity: ReturnType<typeof createInactivityTimer>,
  audioOutputs: AudioOutput[],
  partial = false,
): JsonValue {
  return redactWs({
    catalog: options.catalog,
    path: options.path,
    connection_url: redactWsString(options.url.toString()),
    headers: options.headers ?? {},
    events_sent: state.eventsSent,
    events_received: state.eventsReceived,
    binary_frames_received: state.binaryPaths.length,
    ...(audioOutputs.length > 0
      ? {
          audio_files: audioOutputs.map(({ path, contextId }) => ({
            file: basename(path),
            context_id: contextId,
          })),
        }
      : {}),
    closed: state.closed,
    timed_out: inactivity.timedOut(),
    ...(partial ? { partial: true } : {}),
  });
}

function wsInfo(
  options: WsSessionOptions,
  state: WsSessionState,
  timedOut: boolean,
  partial: boolean,
): WsInfo {
  return {
    catalog: options.catalog,
    path: options.path,
    events_sent: state.eventsSent,
    events_received: state.eventsReceived,
    closed: state.closed,
    timed_out: timedOut,
    ...(partial ? { partial: true } : {}),
  };
}

function terminateSocket(socket: WebSocket): void {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.terminate();
  }
}

class InactivityTimer {
  private timer: NodeJS.Timeout | undefined;
  private didTimeOut = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly timeoutMs: number,
  ) {}

  reset(): void {
    this.clear();
    this.timer = setTimeout(() => this.handleTimeout(), this.timeoutMs);
    this.timer.unref();
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  timedOut(): boolean {
    return this.didTimeOut;
  }

  handleTimeout(): void {
    this.didTimeOut = true;
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close();
    setTimeout(() => {
      if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
    }, 100).unref();
  }
}

function createInactivityTimer(socket: WebSocket, timeoutMs: number): InactivityTimer {
  return new InactivityTimer(socket, timeoutMs);
}

async function processMessage(
  data: RawData,
  socket: WebSocket,
  events: NdjsonEventWriter,
  audio: AudioWriter,
  onDuplexEvent?: (line: string) => void,
): Promise<void> {
  const raw = rawDataToString(data);
  await events.writeRaw(raw);
  const parsed = parseJsonValue(raw, "WebSocket message");
  onDuplexEvent?.(duplexEventLine(parsed));
  await audio.writeFromEvent(parsed);
  const eventId = pingEventId(parsed);
  if (eventId !== undefined && socket.readyState === WebSocket.OPEN) {
    await sendJson(socket, { type: "pong", event_id: eventId });
  }
}

async function playScript(socket: WebSocket, script: SendScriptAction[]): Promise<number> {
  let eventsSent = 0;
  for (const action of script) {
    if (action.type === "close") break;
    if (socket.readyState !== WebSocket.OPEN) break;
    await sendAction(socket, action);
    eventsSent += 1;
  }
  return eventsSent;
}

class DuplexActionReader {
  private readonly lines: ReadlineInterface;
  private readonly iterator: AsyncIterator<string>;

  constructor(
    input: NodeJS.ReadableStream,
    private readonly protocol: WsProtocol | "raw",
  ) {
    this.lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
    this.iterator = this.lines[Symbol.asyncIterator]();
  }

  async next(): Promise<SendScriptAction | null> {
    for (;;) {
      const item = await this.iterator.next();
      if (item.done) return null;
      if (Buffer.byteLength(item.value, "utf8") > MAX_DUPLEX_LINE_BYTES) {
        throw new WsDuplexInputError(
          "ws_duplex_line_too_large",
          `Duplex input line exceeds ${MAX_DUPLEX_LINE_BYTES} bytes`,
        );
      }
      if (item.value.trim().length === 0) continue;
      try {
        parseJsonValue(item.value, "duplex input line");
      } catch {
        throw new WsDuplexInputError(
          "ws_duplex_invalid_json",
          "Duplex input line is not valid JSON",
        );
      }
      let actions: SendScriptAction[];
      try {
        actions = parseSendScript(item.value, this.protocol);
        validateBinaryFiles(actions);
      } catch (error) {
        throw new WsDuplexInputError(
          "ws_duplex_invalid_action",
          error instanceof Error ? error.message : String(error),
        );
      }
      if (actions.length !== 1) {
        throw new WsDuplexInputError(
          "ws_duplex_invalid_action",
          "Each duplex input line must contain exactly one action",
        );
      }
      return actions[0]!;
    }
  }

  close(): void {
    this.lines.close();
  }
}

async function runDuplexSession(
  socket: WebSocket,
  state: WsSessionState,
  closedPromise: Promise<void>,
  reader: DuplexActionReader,
): Promise<void> {
  const inputTask = playDuplex(socket, state, reader);
  try {
    const outcome = await Promise.race([
      closedPromise.then(() => "closed" as const),
      inputTask.then(() => "input_complete" as const),
    ]);
    if (outcome === "input_complete") {
      closeSocketGracefully(socket);
      await closedPromise;
    }
  } finally {
    reader.close();
    await inputTask.catch(() => undefined);
  }
}

async function playDuplex(
  socket: WebSocket,
  state: WsSessionState,
  reader: DuplexActionReader,
): Promise<void> {
  for (;;) {
    const action = await reader.next();
    if (!action || action.type === "close") return;
    if (socket.readyState !== WebSocket.OPEN) return;
    await sendAction(socket, action);
    state.eventsSent += 1;
  }
}

async function sendAction(
  socket: WebSocket,
  action: Exclude<SendScriptAction, { type: "close" }>,
): Promise<void> {
  if (action.type === "send_binary_file") await sendBinaryFile(socket, action.path);
  else if (action.type === "send_audio_file") await sendAudioFile(socket, action);
  else await sendJson(socket, action.data);
}

function closeSocketGracefully(socket: WebSocket): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.close(1000, "duplex input complete");
  setTimeout(() => {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }, 100).unref();
}

async function sendBinaryFile(socket: WebSocket, path: string): Promise<void> {
  const bytes = await readFile(path);
  if (bytes.length > MAX_BINARY_FILE_BYTES) {
    throw new Error(`binary file exceeds ${MAX_BINARY_FILE_BYTES}-byte send limit: ${path}`);
  }
  await new Promise<void>((resolve, reject) => {
    socket.send(bytes, { binary: true }, (error) => (error ? reject(error) : resolve()));
  });
}

async function sendAudioFile(
  socket: WebSocket,
  action: Extract<SendScriptAction, { type: "send_audio_file" }>,
): Promise<void> {
  const bytes = await readFile(action.path);
  if (bytes.length > MAX_BINARY_FILE_BYTES) {
    throw new Error(`binary file exceeds ${MAX_BINARY_FILE_BYTES}-byte send limit: ${action.path}`);
  }
  await sendJson(socket, {
    message_type: "input_audio_chunk",
    audio_base_64: bytes.toString("base64"),
    commit: action.commit,
    sample_rate: action.sampleRate,
    ...(action.previousText === undefined ? {} : { previous_text: action.previousText }),
  });
}

function sendJson(
  socket: WebSocket,
  value: JsonObject | { type: "pong"; event_id: string | number },
): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(JSON.stringify(value), (error) => (error ? reject(error) : resolve()));
  });
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

async function writeBinaryFrame(data: RawData, eventPath: string, index: number): Promise<string> {
  const name = `binary.received-${String(index).padStart(6, "0")}.bin`;
  return await writeBufferToFile(rawDataToBuffer(data), join(dirname(eventPath), name));
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
  return Buffer.from(data);
}

function pingEventId(value: JsonValue): string | number | undefined {
  if (!isRecord(value) || value.type !== "ping") return undefined;
  if (value.ping_event !== undefined) {
    if (!isRecord(value.ping_event)) return undefined;
    const eventId = value.ping_event.event_id;
    return typeof eventId === "number" && Number.isFinite(eventId) ? eventId : undefined;
  }
  const eventId = value.event_id;
  if (typeof eventId === "string" && eventId.length > 0) return eventId;
  return typeof eventId === "number" && Number.isFinite(eventId) ? eventId : undefined;
}
