import { join } from "node:path";
import { redact, redactString } from "../core/redaction";
import { tempFileWriter } from "../core/files";
import { isRecord, parseJson } from "../util/json";
import type { TempFileWriter } from "../core/files";

export type SendScriptAction = { type: "send"; data: Record<string, unknown> } | { type: "close" };

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

export function parseSendScript(raw: string): SendScriptAction[] {
  const actions = raw
    .split(/\r?\n/u)
    .map((line, index) => ({ line: line.trim(), index: index + 1 }))
    .filter(({ line }) => line.length > 0)
    .map(({ line, index }) => parseLine(line, index));

  const firstSend = actions.find((action) => action.type === "send");
  if (!firstSend) throw new Error("send-script must contain at least one send event");
  const text = firstSend.data.text;
  if (typeof text !== "string" || text.length === 0 || text.trim() !== "") {
    throw new Error('first send must be the keep-alive text " "');
  }
  return actions;
}

export function scriptUsesModel(actions: SendScriptAction[], modelId: string): boolean {
  return actions.some(
    (action) =>
      action.type === "send" &&
      typeof action.data.model_id === "string" &&
      action.data.model_id.toLowerCase() === modelId.toLowerCase(),
  );
}

export function redactWs<T>(value: T): T {
  return redactWsStrings(redact(value)) as T;
}

export function redactWsString(value: string): string {
  return redactString(value).replace(
    /([?&](?:single_use_token|authorization|token|conversation_signature|signature|signed_token)=)[^&#\s]+/giu,
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
  if (parsed.type !== "send") throw new Error(`unsupported send-script action on line ${index}`);
  if (!isRecord(parsed.data)) {
    throw new Error(`send-script line ${index} send.data must be an object`);
  }
  return { type: "send", data: parsed.data };
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
