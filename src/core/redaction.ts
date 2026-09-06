const CREDENTIAL_KEYS = new Set([
  "xi-api-key",
  "x-api-key",
  "api_key",
  "authorization",
  "cookie",
  "set-cookie",
  "single_use_token",
  "xi_api_key",
  "token",
  "access_token",
  "refresh_token",
  "participant_token",
  "conversation_token",
  "conversation_signature",
  "signed_url",
  // Assets and completed Flows generations return bearer-capability URLs.
  "content_url",
  "content_urls",
  "hls_manifest_url",
  "dash_manifest_url",
  "client_secret",
  "webhook_secret",
]);

const NORMALIZED_CREDENTIAL_KEYS = new Set(
  [...CREDENTIAL_KEYS].map((key) => normalizeCredentialKey(key)),
);

const URL_CREDENTIAL =
  /([?&](?:single_?use_?token|access_?token|refresh_?token|signed_?token|authorization|token|x-goog-signature|x-amz-signature|x-amz-credential|sig)=)([^&#\s,;"')]+)/giu;

function isCredentialKey(key: string): boolean {
  const normalized = key.toLowerCase();
  const compact = normalizeCredentialKey(key);
  return (
    CREDENTIAL_KEYS.has(normalized) ||
    NORMALIZED_CREDENTIAL_KEYS.has(compact) ||
    (compact.includes("signed") && compact.includes("url")) ||
    normalized.includes("secret") ||
    normalized.includes("api_key") ||
    compact.includes("apikey")
  );
}

function normalizeCredentialKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/gu, "");
}

export function containsCredential(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === "string") {
    return [...value.matchAll(URL_CREDENTIAL)].some((match) => match[2] !== "[REDACTED]");
  }
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsCredential(item, seen));
  return Object.entries(value).some(
    ([key, child]) =>
      (isCredentialKey(key) &&
        typeof child !== "boolean" &&
        child != null &&
        child !== "[REDACTED]") ||
      containsCredential(child, seen),
  );
}

export function redactString(value: string): string {
  return value
    .replace(URL_CREDENTIAL, "$1[REDACTED]")
    .replace(
      /("(?:token|single_?use_?token|access_?token|refresh_?token|participant_?token|conversation_?token|conversation_?signature|[a-z_-]*signed[a-z_-]*url|content_?urls?|hls_manifest_url|dash_manifest_url|client_?secret|webhook_?secret|xi-?api-?key|api_?key)"\s*:\s*")(?:\\.|[^"\\])*/giu,
      "$1[REDACTED]",
    )
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
  if (key && isCredentialKey(key) && value != null && typeof value !== "boolean")
    return "[REDACTED]";
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
