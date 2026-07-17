import { errorMessage } from "./error";

export type JsonValue = string | number | boolean | null | JsonObject | readonly JsonValue[];
export type JsonObject = { [key: string]: JsonValue };
export type JsonInputValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | JsonObjectInput
  | readonly JsonInputValue[];
export type JsonObjectInput = { [key: string]: JsonInputValue };

export class JsonParseError extends Error {
  override name = "JsonParseError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export function parseJson(raw: string, label = "JSON"): JsonValue {
  try {
    return JSON.parse(raw) as JsonValue;
  } catch (error) {
    throw new JsonParseError(`${label} is not valid JSON: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

export function parseJsonRecord(
  raw: string,
  label = "JSON",
  objectMessage = `${label} must be an object`,
): JsonObject {
  const parsed = parseJson(raw, label);
  if (isRecord(parsed)) return parsed;
  throw new Error(objectMessage);
}

export function isRecord(value: JsonValue): value is JsonObject;
export function isRecord(value: JsonInputValue): value is JsonObjectInput;
export function isRecord(value: unknown): value is Record<string, unknown>;
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
