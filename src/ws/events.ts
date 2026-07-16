import { join } from "node:path";
import { statSync } from "node:fs";
import { redact, redactString } from "../core/redaction";
import { tempFileWriter } from "../core/files";
import { isRecord, parseJson } from "../util/json";
import type { TempFileWriter } from "../core/files";

import type { WsProtocol } from "./catalog";

export const MAX_BINARY_FILE_BYTES = 64 * 1024 * 1024;

export type SendScriptAction =
  | { type: "send"; data: Record<string, unknown> }
  | { type: "send_binary_file"; path: string }
  | { type: "close" };

export class NdjsonEventWriter {
  readonly path: string;
  private readonly writer: TempFileWriter;

  constructor(dir: string) {
    this.path = join(dir, "events.received.ndjson");
    this.writer = tempFileWriter(this.path);
  }

  async writeRaw(raw: string): Promise<void> {
    await this.writer.write(`${redactedEventLine(raw)}\n`);
  }

  async close(): Promise<string> {
    return this.writer.close();
  }

  async abort(): Promise<void> {
    await this.writer.abort();
  }
}

export function parseSendScript(
  raw: string,
  protocol: WsProtocol | "raw" = "tts",
): SendScriptAction[] {
  const actions = raw
    .split(/\r?\n/u)
    .map((line, index) => ({ line: line.trim(), index: index + 1 }))
    .filter(({ line }) => line.length > 0)
    .map(({ line, index }) => parseLine(line, index));

  validateProtocolActions(actions, protocol);
  return actions;
}

export function validateBinaryFiles(actions: SendScriptAction[]): void {
  for (const action of actionsBeforeClose(actions)) {
    if (action.type !== "send_binary_file") continue;
    let stats;
    try {
      stats = statSync(action.path);
    } catch {
      throw new Error(`binary file does not exist: ${action.path}`);
    }
    if (!stats.isFile()) throw new Error(`binary path is not a file: ${action.path}`);
    if (stats.size > MAX_BINARY_FILE_BYTES) {
      throw new Error(
        `binary file exceeds ${MAX_BINARY_FILE_BYTES}-byte send limit: ${action.path}`,
      );
    }
  }
}

export function scriptUsesModel(actions: SendScriptAction[], modelId: string): boolean {
  return actionsBeforeClose(actions).some(
    (action) =>
      action.type === "send" &&
      typeof action.data.model_id === "string" &&
      action.data.model_id.toLowerCase() === modelId.toLowerCase(),
  );
}

export function outboundActionCount(actions: SendScriptAction[]): number {
  return actionsBeforeClose(actions).length;
}

export function ttsCharacterEstimate(actions: SendScriptAction[], modelId: string): number {
  const characters = actionsBeforeClose(actions).reduce(
    (total, action) =>
      action.type === "send" && typeof action.data.text === "string"
        ? total + action.data.text.length
        : total,
    0,
  );
  return characters * (/flash|turbo/iu.test(modelId) ? 0.5 : 1);
}

export function redactWs<T>(value: T): T {
  return redactWsStrings(redact(value)) as T;
}

export function redactWsString(value: string): string {
  return redactString(value).replace(
    /([?&](?:single_use_token|authorization|token|conversation_signature|signature|signed_token|signed_url|xi_api_key|xi-api-key)=)[^&#\s]+/giu,
    "$1[REDACTED]",
  );
}

function parseLine(line: string, index: number): SendScriptAction {
  let parsed: unknown;
  try {
    parsed = parseJson(line, `send-script line ${index}`);
  } catch (error) {
    throw new Error(`send-script line ${index} is not valid JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`send-script line ${index} must be a JSON object`);
  }
  if (parsed.type === "close") return { type: "close" };
  if (parsed.type === "send_binary_file") {
    if (typeof parsed.path !== "string" || parsed.path.length === 0) {
      throw new Error(`send-script line ${index} send_binary_file.path must be a string`);
    }
    return { type: "send_binary_file", path: parsed.path };
  }
  if (parsed.type !== "send") throw new Error(`unsupported send-script action on line ${index}`);
  if (!isRecord(parsed.data)) {
    throw new Error(`send-script line ${index} send.data must be an object`);
  }
  return { type: "send", data: parsed.data };
}

function validateProtocolActions(actions: SendScriptAction[], protocol: WsProtocol | "raw"): void {
  if (protocol === "tts") {
    const firstSend = actionsBeforeClose(actions)[0];
    if (!firstSend || firstSend.type !== "send") {
      throw new Error("send-script must contain a TTS keep-alive send event");
    }
    const text = firstSend.data.text;
    if (typeof text !== "string" || text.length === 0 || text.trim() !== "") {
      throw new Error('first TTS send must be the keep-alive text " "');
    }
  }
  if (protocol !== "stt" && protocol !== "raw") {
    if (actionsBeforeClose(actions).some((action) => action.type === "send_binary_file")) {
      throw new Error(`send_binary_file is not supported by the ${protocol} protocol`);
    }
  }
}

function actionsBeforeClose(actions: SendScriptAction[]): SendScriptAction[] {
  const closeIndex = actions.findIndex((action) => action.type === "close");
  return closeIndex === -1 ? actions : actions.slice(0, closeIndex);
}

function redactedEventLine(raw: string): string {
  try {
    return JSON.stringify(redactWs(parseJson(raw, "WebSocket event")));
  } catch {
    return redactWsString(raw);
  }
}

function redactWsStrings(value: unknown): unknown {
  if (typeof value === "string") return redactWsString(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactWsStrings);
  const output: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    output[key] = isWsSecretKey(key) ? "[REDACTED]" : redactWsStrings(entryValue);
  }
  return output;
}

function isWsSecretKey(key: string): boolean {
  return [
    "single_use_token",
    "authorization",
    "token",
    "conversation_signature",
    "signature",
    "signed_token",
    "signed_url",
    "xi-api-key",
    "xi_api_key",
  ].includes(key.toLowerCase());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
