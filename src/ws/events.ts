import { join } from "node:path";
import { statSync } from "node:fs";
import { redact, redactString } from "../core/redaction";
import { tempFileWriter } from "../core/files";
import { errorMessage } from "../util/error";
import { isRecord, parseJson } from "../util/json";
import type { TempFileWriter } from "../core/files";
import type { JsonObject, JsonValue } from "../util/json";

import type { WsProtocol } from "./catalog";

export const MAX_BINARY_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_DUPLEX_LINE_BYTES = 1024 * 1024;

export type SendScriptAction =
  | { type: "send"; data: JsonObject }
  | {
      type: "send_audio_file";
      path: string;
      sampleRate: number;
      commit: boolean;
      previousText?: string;
    }
  | { type: "send_binary_file"; path: string }
  | { type: "close" };

export class NdjsonEventWriter {
  readonly path: string;
  private readonly writer: TempFileWriter;
  private wroteEvent = false;

  constructor(dir: string) {
    this.path = join(dir, "events.received.ndjson");
    this.writer = tempFileWriter(this.path);
  }

  async writeRaw(raw: string): Promise<void> {
    await this.writer.write(`${redactedEventLine(raw)}\n`);
    this.wroteEvent = true;
  }

  get hasData(): boolean {
    return this.wroteEvent;
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
    if (action.type !== "send_binary_file" && action.type !== "send_audio_file") continue;
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
      action.type === "send" ? total + messageCharacterCount(action.data) : total,
    0,
  );
  return characters * (/flash|turbo/iu.test(modelId) ? 0.5 : 1);
}

export function validateTtdModel(
  actions: SendScriptAction[],
  protocol: Extract<WsProtocol, "ttd" | "ttd-multi">,
  modelId: string,
): void {
  if (!modelId.toLowerCase().startsWith("eleven_v3")) {
    throw new Error("Text to Dialogue WebSockets require a model_id beginning with eleven_v3");
  }
  if (modelId.toLowerCase() !== "eleven_v3_conversational") return;
  for (const count of ttdInitialVoiceCounts(actions, protocol)) {
    if (count !== 1) {
      throw new Error("eleven_v3_conversational requires exactly one registered voice per context");
    }
  }
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

export function duplexEventLine(value: JsonValue): string {
  return JSON.stringify(stripDuplexAudio(redactWs(value)));
}

function parseLine(line: string, index: number): SendScriptAction {
  let parsed: JsonValue;
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
  if (parsed.type === "send_audio_file") {
    if (typeof parsed.path !== "string" || parsed.path.length === 0) {
      throw new Error(`send-script line ${index} send_audio_file.path must be a string`);
    }
    if (
      typeof parsed.sample_rate !== "number" ||
      !Number.isInteger(parsed.sample_rate) ||
      parsed.sample_rate <= 0
    ) {
      throw new Error(
        `send-script line ${index} send_audio_file.sample_rate must be a positive integer`,
      );
    }
    if (typeof parsed.commit !== "boolean") {
      throw new Error(`send-script line ${index} send_audio_file.commit must be a boolean`);
    }
    if (parsed.previous_text !== undefined && typeof parsed.previous_text !== "string") {
      throw new Error(`send-script line ${index} send_audio_file.previous_text must be a string`);
    }
    return {
      type: "send_audio_file",
      path: parsed.path,
      sampleRate: parsed.sample_rate,
      commit: parsed.commit,
      ...(parsed.previous_text === undefined ? {} : { previousText: parsed.previous_text }),
    };
  }
  if (parsed.type !== "send") throw new Error(`unsupported send-script action on line ${index}`);
  if (!isRecord(parsed.data)) {
    throw new Error(`send-script line ${index} send.data must be an object`);
  }
  return { type: "send", data: parsed.data as JsonObject };
}

function validateProtocolActions(actions: SendScriptAction[], protocol: WsProtocol | "raw"): void {
  const activeActions = actionsBeforeClose(actions);
  if (protocol !== "raw" && activeActions.some((action) => action.type === "send_binary_file")) {
    throw new Error("send_binary_file is supported only by raw WebSocket sessions");
  }
  if (protocol !== "stt" && activeActions.some((action) => action.type === "send_audio_file")) {
    throw new Error("send_audio_file is only supported by the realtime STT protocol");
  }
  if (protocol === "tts") {
    const firstSend = activeActions[0];
    if (!firstSend || firstSend.type !== "send") {
      throw new Error("send-script must contain a TTS keep-alive send event");
    }
    const text = firstSend.data.text;
    if (typeof text !== "string" || text.length === 0 || text.trim() !== "") {
      throw new Error('first TTS send must be the keep-alive text " "');
    }
  }
  if (protocol === "ttd") validateSingleTtd(activeActions);
  if (protocol === "ttd-multi") validateMultiTtd(activeActions);
}

function actionsBeforeClose(actions: SendScriptAction[]): SendScriptAction[] {
  const closeIndex = actions.findIndex((action) => action.type === "close");
  return closeIndex === -1 ? actions : actions.slice(0, closeIndex);
}

function messageCharacterCount(data: JsonObject): number {
  let total = typeof data.text === "string" ? data.text.length : 0;
  if (!Array.isArray(data.inputs)) return total;
  for (const input of data.inputs) {
    if (isRecord(input) && typeof input.text === "string") total += input.text.length;
  }
  return total;
}

function validateSingleTtd(actions: SendScriptAction[]): void {
  const sends = sendActions(actions, "Text to Dialogue");
  const voices = validateTtdInit(sends[0]!.data, "first Text to Dialogue message");
  validateTtdMessage(sends[0]!.data, voices, "first Text to Dialogue message");
  for (const [offset, action] of sends.slice(1).entries()) {
    const label = `Text to Dialogue message ${offset + 2}`;
    rejectInitFields(action.data, label, true);
    validateTtdMessage(action.data, voices, label);
  }
}

function validateMultiTtd(actions: SendScriptAction[]): void {
  const sends = sendActions(actions, "multi-context Text to Dialogue");
  const contexts = new Map<string, Set<string>>();
  let socketClosed = false;
  for (const [index, action] of sends.entries()) {
    const data = action.data;
    const label = `multi-context Text to Dialogue message ${index + 1}`;
    if (socketClosed) throw new Error(`${label} appears after close_socket`);
    validateBooleanFields(data, label, ["flush", "close_context", "close_socket", "keep_alive"]);
    if (data.close_socket !== undefined) {
      if (data.close_socket !== true || Object.keys(data).length !== 1) {
        throw new Error(`${label} close_socket must be true and the only field`);
      }
      socketClosed = true;
      continue;
    }
    const contextId = requiredString(data.context_id, `${label}.context_id`);
    let voices = contexts.get(contextId);
    if (!voices) {
      if (contexts.size >= 5) {
        throw new Error(`${label} exceeds the maximum of 5 simultaneous contexts`);
      }
      voices = validateTtdInit(data, label);
      contexts.set(contextId, voices);
    } else {
      rejectInitFields(data, label, false);
    }
    if (index > 0) rejectCredentialFields(data, label);
    validateTtdMessage(data, voices, label);
    if (data.close_context === true) contexts.delete(contextId);
  }
}

function sendActions(
  actions: SendScriptAction[],
  protocolName: string,
): Extract<SendScriptAction, { type: "send" }>[] {
  if (actions.length === 0 || actions[0]!.type !== "send") {
    throw new Error(`send-script must begin with a ${protocolName} send event`);
  }
  if (actions.some((action) => action.type !== "send")) {
    throw new Error(`${protocolName} scripts support JSON send events only`);
  }
  return actions as Extract<SendScriptAction, { type: "send" }>[];
}

function validateTtdInit(data: JsonObject, label: string): Set<string> {
  if (!Array.isArray(data.voices) || data.voices.length === 0 || data.voices.length > 10) {
    throw new Error(`${label}.voices must contain 1 to 10 voice IDs`);
  }
  const voices = new Set<string>();
  for (const voice of data.voices) {
    if (typeof voice !== "string" || voice.length === 0) {
      throw new Error(`${label}.voices must contain non-empty strings`);
    }
    if (voices.has(voice)) throw new Error(`${label}.voices must not contain duplicates`);
    voices.add(voice);
  }
  validateVoiceSettings(data.voice_settings, label);
  validatePronunciationDictionaries(data.pronunciation_dictionary_locators, label);
  validateCredentialFields(data, label);
  return voices;
}

function validateTtdMessage(data: JsonObject, voices: Set<string>, label: string): void {
  validateBooleanFields(data, label, ["flush", "close_socket", "keep_alive"]);
  if (data.inputs === undefined) return;
  if (!Array.isArray(data.inputs)) throw new Error(`${label}.inputs must be an array`);
  for (const [index, input] of data.inputs.entries()) {
    if (!isRecord(input)) throw new Error(`${label}.inputs[${index}] must be an object`);
    if (typeof input.text !== "string") {
      throw new Error(`${label}.inputs[${index}].text must be a string`);
    }
    const voiceId = requiredString(input.voice_id, `${label}.inputs[${index}].voice_id`);
    if (!voices.has(voiceId)) {
      throw new Error(`${label}.inputs[${index}].voice_id is not registered for this context`);
    }
    if (input.new_turn !== undefined && typeof input.new_turn !== "boolean") {
      throw new Error(`${label}.inputs[${index}].new_turn must be a boolean`);
    }
  }
}

function rejectInitFields(data: JsonObject, label: string, includeCredentials: boolean): void {
  for (const field of ["voices", "voice_settings", "pronunciation_dictionary_locators"]) {
    if (data[field] !== undefined)
      throw new Error(`${label}.${field} is allowed only during initialization`);
  }
  if (includeCredentials) rejectCredentialFields(data, label);
}

function rejectCredentialFields(data: JsonObject, label: string): void {
  for (const field of ["xi_api_key", "authorization", "single_use_token"]) {
    if (data[field] !== undefined) {
      throw new Error(`${label}.${field} is allowed only in the first connection message`);
    }
  }
}

function validateCredentialFields(data: JsonObject, label: string): void {
  for (const field of ["xi_api_key", "authorization", "single_use_token"]) {
    if (data[field] !== undefined) requiredString(data[field], `${label}.${field}`);
  }
}

function validateVoiceSettings(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error(`${label}.voice_settings must be an object`);
  if (
    value.stability !== undefined &&
    (typeof value.stability !== "number" || value.stability < 0 || value.stability > 1)
  ) {
    throw new Error(`${label}.voice_settings.stability must be between 0 and 1`);
  }
}

function validatePronunciationDictionaries(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new Error(`${label}.pronunciation_dictionary_locators must be an array`);
  }
  for (const [index, locator] of value.entries()) {
    if (!isRecord(locator)) {
      throw new Error(`${label}.pronunciation_dictionary_locators[${index}] must be an object`);
    }
    requiredString(
      locator.pronunciation_dictionary_id,
      `${label}.pronunciation_dictionary_locators[${index}].pronunciation_dictionary_id`,
    );
    requiredString(
      locator.version_id,
      `${label}.pronunciation_dictionary_locators[${index}].version_id`,
    );
  }
}

function validateBooleanFields(data: JsonObject, label: string, fields: string[]): void {
  for (const field of fields) {
    if (data[field] !== undefined && typeof data[field] !== "boolean") {
      throw new Error(`${label}.${field} must be a boolean`);
    }
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function ttdInitialVoiceCounts(
  actions: SendScriptAction[],
  protocol: Extract<WsProtocol, "ttd" | "ttd-multi">,
): number[] {
  const sends = actionsBeforeClose(actions).filter(
    (action): action is Extract<SendScriptAction, { type: "send" }> => action.type === "send",
  );
  if (protocol === "ttd")
    return [Array.isArray(sends[0]?.data.voices) ? sends[0].data.voices.length : 0];
  return sends.flatMap((action) =>
    Array.isArray(action.data.voices) ? [action.data.voices.length] : [],
  );
}

function redactedEventLine(raw: string): string {
  try {
    return JSON.stringify(redactWs(parseJson(raw, "WebSocket event")));
  } catch {
    return redactWsString(raw);
  }
}

function stripDuplexAudio(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stripDuplexAudio);
  const output: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    output[key] =
      ["audio", "audio_base64", "audio_base_64", "user_audio_chunk"].includes(key.toLowerCase()) &&
      typeof entryValue === "string"
        ? "[AUDIO OMITTED]"
        : stripDuplexAudio(entryValue);
  }
  return output;
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
