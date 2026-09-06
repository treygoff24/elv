import { statSync } from "node:fs";
import { decodeBase64 } from "../core/encoding";
import { isRecord, type JsonObject, type JsonValue } from "../util/json";

export const MAX_RTC_LINE_BYTES = 1024 * 1024;
export const MAX_RTC_FILE_BYTES = 64 * 1024 * 1024;

export type RtcAction =
  | { type: "send"; data: JsonObject }
  | { type: "send_audio_file"; path: string; sample_rate: number; channels?: number }
  | { type: "send_audio"; audio_base_64: string; sample_rate: number; channels?: number }
  | {
      type: "send_data";
      data?: JsonValue;
      base64?: string;
      topic?: string;
      reliable?: boolean;
      destination_identities?: string[];
    }
  | { type: "wait"; ms: number }
  | { type: "close" };

export function validateRtcAction(value: unknown): RtcAction {
  if (!isRecord(value)) throw new Error("RTC action must be an object");
  const allowed: Record<string, string[]> = {
    send: ["type", "data"],
    send_audio_file: ["type", "path", "sample_rate", "channels"],
    send_audio: ["type", "audio_base_64", "sample_rate", "channels"],
    send_data: ["type", "data", "base64", "topic", "reliable", "destination_identities"],
    wait: ["type", "ms"],
    close: ["type"],
  };
  if (typeof value.type !== "string" || !Object.hasOwn(allowed, value.type))
    throw new Error("Unknown RTC action type");
  if (Object.keys(value).some((key) => !allowed[value.type as string]!.includes(key)))
    throw new Error("Unknown RTC action field");
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_RTC_LINE_BYTES)
    throw new Error("RTC action exceeds 1 MiB");
  switch (value.type) {
    case "send":
      if (!isRecord(value.data) || typeof value.data.type !== "string" || !value.data.type)
        throw new Error("RTC send requires a client event object with a type");
      if (Object.hasOwn(value.data, "user_audio_chunk") || value.data.type === "user_audio_chunk")
        throw new Error(
          "RTC audio must use send_audio or send_audio_file, not a WebSocket user_audio_chunk event",
        );
      return { type: "send", data: value.data as JsonObject };
    case "send_audio": {
      if (typeof value.audio_base_64 !== "string")
        throw new Error("RTC send_audio requires audio_base_64");
      if (
        (value.sample_rate !== undefined && value.sample_rate !== 48000) ||
        (value.channels !== undefined && value.channels !== 1)
      )
        throw new Error("ElevenLabs RTC input must be PCM16LE at 48000 Hz, mono");
      if (decodeBase64(value.audio_base_64, "RTC input").byteLength % 2 !== 0)
        throw new Error("PCM16LE requires complete 16-bit samples");
      return {
        type: "send_audio",
        audio_base_64: value.audio_base_64,
        sample_rate: 48000,
        channels: 1,
      };
    }
    case "send_audio_file":
      if (typeof value.path !== "string" || !value.path || value.path.includes("\0"))
        throw new Error("RTC audio requires a file path");
      if (
        (value.sample_rate !== undefined && value.sample_rate !== 48000) ||
        (value.channels !== undefined && value.channels !== 1)
      )
        throw new Error("ElevenLabs RTC input must be PCM16LE at 48000 Hz, mono");
      return { type: "send_audio_file", path: value.path, sample_rate: 48000, channels: 1 };
    case "send_data":
      if (Object.hasOwn(value, "data") === Object.hasOwn(value, "base64"))
        throw new Error("send_data requires exactly one of data or base64");
      if (value.base64 !== undefined) {
        if (typeof value.base64 !== "string") throw new Error("send_data base64 must be a string");
        decodeBase64(value.base64, "RTC data packet");
      }
      if (value.topic !== undefined && typeof value.topic !== "string")
        throw new Error("RTC data topic must be a string");
      if (value.reliable !== undefined && typeof value.reliable !== "boolean")
        throw new Error("RTC reliable must be boolean");
      if (
        value.destination_identities !== undefined &&
        (!Array.isArray(value.destination_identities) ||
          !value.destination_identities.every((id) => typeof id === "string" && id.length > 0))
      )
        throw new Error("RTC destination identities must be strings");
      return value as RtcAction;
    case "wait":
      if (
        typeof value.ms !== "number" ||
        !Number.isSafeInteger(value.ms) ||
        value.ms < 0 ||
        value.ms > 2_147_483_647
      )
        throw new Error("RTC wait ms must be a non-negative finite integer");
      return { type: "wait", ms: value.ms };
    default:
      return { type: "close" };
  }
}

export function parseRtcScript(raw: string): RtcAction[] {
  if (Buffer.byteLength(raw) > 16 * 1024 * 1024) throw new Error("RTC script exceeds 16 MiB");
  const actions = raw.split(/\r?\n/u).flatMap((line, index) => {
    if (!line.trim()) return [];
    return [parseRtcActionLine(line, index + 1)];
  });
  if (actions.length > 10_000) throw new Error("RTC script exceeds 10000 actions");
  let outbound = false;
  let closed = false;
  for (const action of actions) {
    if (closed) throw new Error("RTC close must be the final action");
    if (action.type === "close") closed = true;
    if (action.type === "wait" || action.type === "close") continue;
    if (
      action.type === "send" &&
      action.data.type === "conversation_initiation_client_data" &&
      outbound
    )
      throw new Error("RTC initialization must precede other outbound actions");
    outbound = true;
  }
  return actions;
}

export function parseRtcActionLine(line: string, index = 1): RtcAction {
  if (Buffer.byteLength(line) > MAX_RTC_LINE_BYTES)
    throw new Error(`RTC line ${index} exceeds 1 MiB`);
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`Invalid JSON on RTC line ${index}`);
  }
  return validateRtcAction(value);
}

export function validateRtcFiles(actions: RtcAction[]): void {
  for (const action of actions) {
    if (action.type !== "send_audio_file") continue;
    const stat = statSync(action.path);
    if (!stat.isFile()) throw new Error("RTC audio input must be a regular file");
    if (stat.size === 0 || stat.size % 2 !== 0)
      throw new Error("PCM16LE input must contain complete nonempty 16-bit samples");
    if (stat.size > MAX_RTC_FILE_BYTES) throw new Error("RTC audio input exceeds 64 MiB");
  }
}
