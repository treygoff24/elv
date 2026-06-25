const SECRET_KEYS = new Set([
  "xi-api-key",
  "x-api-key",
  "authorization",
  "cookie",
  "set-cookie",
  "single_use_token",
  "xi_api_key",
  "token",
  "conversation_signature",
]);

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    SECRET_KEYS.has(normalized) ||
    normalized.includes("secret") ||
    normalized.includes("api_key") ||
    normalized.includes("apikey")
  );
}

export function redactString(value: string): string {
  return value
    .replace(/([?&](?:single_use_token|authorization|token)=)[^&#\s]+/giu, "$1[REDACTED]")
    .replace(/\bBearer\s+[^\s,;"')]+/giu, "Bearer [REDACTED]")
    .replace(/\bsk_[A-Za-z0-9_-]+/gu, "sk_[REDACTED]");
}

// Single redaction chokepoint: stdout envelopes and ELV_DEBUG stderr logs must pass through here.
export function redact<T>(value: T): T {
  return cloneRedacted(value, undefined, new WeakMap<object, unknown>()) as T;
}

function cloneRedacted(
  value: unknown,
  key: string | undefined,
  seen: WeakMap<object, unknown>,
): unknown {
  if (key && isSecretKey(key) && typeof value !== "boolean") return "[REDACTED]";
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;

  const previous = seen.get(value);
  if (previous) return previous;

  if (Array.isArray(value)) {
    const output: unknown[] = [];
    seen.set(value, output);
    for (const item of value) output.push(cloneRedacted(item, undefined, seen));
    return output;
  }

  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof Uint8Array) return new Uint8Array(value);

  const output: Record<string, unknown> = {};
  seen.set(value, output);
  for (const [entryKey, entryValue] of Object.entries(value)) {
    output[entryKey] = cloneRedacted(entryValue, entryKey, seen);
  }
  return output;
}
