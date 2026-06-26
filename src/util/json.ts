export class JsonParseError extends Error {
  override name = "JsonParseError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export function parseJson(raw: string, label = "JSON"): unknown {
  try {
    return JSON.parse(raw) as unknown;
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
): Record<string, unknown> {
  const parsed = parseJson(raw, label);
  if (isRecord(parsed)) return parsed;
  throw new Error(objectMessage);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
