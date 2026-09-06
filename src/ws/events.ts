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
const DEFAULT_TTS_CONTEXT = "\0default";

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
  options: { modelId?: string } = {},
): SendScriptAction[] {
  const actions = raw
    .split(/\r?\n/u)
    .map((line, index) => ({ line: line.trim(), index: index + 1 }))
    .filter(({ line }) => line.length > 0)
    .map(({ line, index }) => parseSendScriptLine(line, index));

  const validator = new WsProtocolValidator(protocol, options);
  for (const action of actionsBeforeClose(actions)) validator.validate(action);
  validator.finishStatic();
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

export function parseSendScriptLine(line: string, index = 1): SendScriptAction {
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

export class WsProtocolValidator {
  private position = 0;
  private closed = false;
  private ttsInitialized = false;
  private ttsMultiInitialized = false;
  private readonly ttsContexts = new Set<string>();
  private sttChunks = 0;
  private ttdVoices: Set<string> | undefined;
  private readonly ttdContexts = new Map<string, Set<string>>();
  private readonly modelId: string | undefined;

  constructor(
    private readonly protocol: WsProtocol | "raw",
    options: { modelId?: string } = {},
  ) {
    this.modelId = options.modelId?.toLowerCase();
    if (
      (protocol === "ttd" || protocol === "ttd-multi") &&
      this.modelId !== undefined &&
      !this.modelId.startsWith("eleven_v3")
    ) {
      throw new Error("Text to Dialogue WebSockets require a model_id beginning with eleven_v3");
    }
  }

  validate(action: SendScriptAction): void {
    this.position += 1;
    const label = `${this.protocol} message ${this.position}`;
    // An explicit close is accepted at any point, including after a terminal protocol
    // message. Static scripts never validate it (parseSendScript stops at the close), so
    // rejecting it over duplex stdin would fail a session that already completed.
    if (action.type === "close") {
      this.closed = true;
      return;
    }
    if (this.closed) throw new Error(`${label} appears after the protocol was closed`);
    if (action.type === "send_binary_file") {
      if (this.protocol !== "raw") {
        throw new Error("send_binary_file is supported only by raw WebSocket sessions");
      }
      return;
    }
    if (action.type === "send_audio_file") {
      if (this.protocol !== "stt") {
        throw new Error("send_audio_file is only supported by the realtime STT protocol");
      }
      this.validateSttPreviousText(action.previousText, label);
      this.sttChunks += 1;
      return;
    }

    if (this.protocol === "tts") this.validateTts(action.data, label);
    else if (this.protocol === "tts-multi") this.validateTtsMulti(action.data, label);
    else if (this.protocol === "stt") this.validateStt(action.data, label);
    else if (this.protocol === "ttd") this.validateTtd(action.data, label);
    else if (this.protocol === "ttd-multi") this.validateTtdMulti(action.data, label);
  }

  finishStatic(): void {
    if (this.protocol === "tts" && !this.ttsInitialized) {
      throw new Error("send-script must contain a TTS keep-alive send event");
    }
    if (this.protocol === "tts-multi" && !this.ttsMultiInitialized) {
      throw new Error("send-script must contain a TTS multi-context initialization event");
    }
    if (this.protocol === "ttd" && !this.ttdVoices) {
      throw new Error("send-script must begin with a Text to Dialogue send event");
    }
    if (this.protocol === "ttd-multi" && this.position === 0) {
      throw new Error("send-script must begin with a multi-context Text to Dialogue send event");
    }
  }

  private validateTts(data: JsonObject, label: string): void {
    for (const field of ["close_socket", "close_context", "context_id"]) {
      if (data[field] !== undefined) {
        throw new Error(`${label}.${field} is not supported by single-context TTS`);
      }
    }
    validateBooleanFields(data, label, ["flush", "try_trigger_generation"]);
    const text = data.text;
    if (!this.ttsInitialized) {
      if (text !== " ") {
        throw new Error('first TTS send must be the keep-alive text " "');
      }
      this.ttsInitialized = true;
      return;
    }
    if (typeof text !== "string") throw new Error(`${label}.text must be a string`);
    if (text === "") this.closed = true;
  }

  private validateTtsMulti(data: JsonObject, label: string): void {
    validateBooleanFields(data, label, ["flush", "close_context", "close_socket"]);
    if (!this.ttsMultiInitialized) {
      if (data.text !== " ") {
        throw new Error('first TTS multi-context send must have the initialization text " "');
      }
      const contextId = optionalContextId(data.context_id, label);
      this.ttsContexts.add(contextId);
      this.ttsMultiInitialized = true;
      return;
    }
    if (data.close_socket !== undefined) {
      if (data.close_socket !== true || Object.keys(data).length !== 1) {
        throw new Error(`${label}.close_socket must be true and the only field`);
      }
      this.closed = true;
      return;
    }
    if (data.close_context !== undefined) {
      if (data.close_context !== true) {
        throw new Error(`${label}.close_context must be true`);
      }
      const contextId = requiredString(data.context_id, `${label}.context_id`);
      if (!this.ttsContexts.has(contextId)) {
        throw new Error(`${label}.context_id is not an active TTS context`);
      }
      this.ttsContexts.delete(contextId);
      return;
    }
    if (data.text === undefined) {
      if (data.flush === undefined) {
        throw new Error(`${label} must contain text or a context control`);
      }
      const contextId = requiredString(data.context_id, `${label}.context_id`);
      if (!this.ttsContexts.has(contextId)) {
        throw new Error(`${label}.context_id is not an active TTS context`);
      }
      return;
    }
    if (typeof data.text !== "string") throw new Error(`${label}.text must be a string`);
    const contextId = optionalContextId(data.context_id, label);
    if (data.text === "" && !this.ttsContexts.has(contextId)) {
      throw new Error(`${label}.context_id is not an active TTS context`);
    }
    this.ttsContexts.add(contextId);
  }

  private validateStt(data: JsonObject, label: string): void {
    if (data.message_type !== "input_audio_chunk") {
      throw new Error(`${label}.message_type must be input_audio_chunk`);
    }
    if (typeof data.audio_base_64 !== "string") {
      throw new Error(`${label}.audio_base_64 must be a string`);
    }
    if (typeof data.commit !== "boolean") throw new Error(`${label}.commit must be a boolean`);
    if (
      typeof data.sample_rate !== "number" ||
      !Number.isInteger(data.sample_rate) ||
      data.sample_rate <= 0
    ) {
      throw new Error(`${label}.sample_rate must be a positive integer`);
    }
    this.validateSttPreviousText(data.previous_text, label);
    this.sttChunks += 1;
  }

  private validateSttPreviousText(value: unknown, label: string): void {
    if (value === undefined) return;
    if (typeof value !== "string") throw new Error(`${label}.previous_text must be a string`);
    if (this.sttChunks > 0) {
      throw new Error(`${label}.previous_text is accepted only with the first audio chunk`);
    }
  }

  private validateTtd(data: JsonObject, label: string): void {
    if (!this.ttdVoices) {
      this.ttdVoices = validateTtdInit(data, label);
      this.validateTtdVoiceCount(this.ttdVoices.size, label);
    } else {
      rejectInitFields(data, label, true);
    }
    validateTtdMessage(data, this.ttdVoices, label);
    if (data.close_socket === true) this.closed = true;
  }

  private validateTtdMulti(data: JsonObject, label: string): void {
    validateBooleanFields(data, label, ["flush", "close_context", "close_socket", "keep_alive"]);
    if (data.close_socket !== undefined) {
      if (data.close_socket !== true || Object.keys(data).length !== 1) {
        throw new Error(`${label} close_socket must be true and the only field`);
      }
      this.closed = true;
      return;
    }
    const contextId = requiredString(data.context_id, `${label}.context_id`);
    let voices = this.ttdContexts.get(contextId);
    if (!voices) {
      if (this.ttdContexts.size >= 5) {
        throw new Error(`${label} exceeds the maximum of 5 simultaneous contexts`);
      }
      voices = validateTtdInit(data, label);
      this.validateTtdVoiceCount(voices.size, label);
      this.ttdContexts.set(contextId, voices);
    } else {
      rejectInitFields(data, label, false);
    }
    if (this.position > 1) rejectCredentialFields(data, label);
    validateTtdMessage(data, voices, label);
    if (data.close_context === true) this.ttdContexts.delete(contextId);
  }

  private validateTtdVoiceCount(count: number, label: string): void {
    if (this.modelId === "eleven_v3_conversational" && count !== 1) {
      throw new Error(`${label} requires exactly one voice for eleven_v3_conversational`);
    }
  }
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

function optionalContextId(value: unknown, label: string): string {
  return value === undefined ? DEFAULT_TTS_CONTEXT : requiredString(value, `${label}.context_id`);
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
