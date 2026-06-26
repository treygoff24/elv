import { classifyTypeFromStatus } from "./errors";
import type { NormalizedError } from "./types";

export function normalizeProviderError(
  body: unknown,
  httpStatus: number,
  headers: Headers,
): NormalizedError {
  const raw = body;
  const detail = detailValue(body);
  const requestIdFromHeader = header(headers, "request-id");

  if (Array.isArray(detail)) {
    const first = asRecord(detail[0]);
    const loc = Array.isArray(first.loc) ? first.loc : [];
    const msg = stringValue(first.msg) ?? statusText(httpStatus);
    const prefix = typeof loc[0] === "string" ? `${loc[0]}: ` : "";
    return {
      type: classifyTypeFromStatus(httpStatus),
      code: "validation_error",
      message: `${prefix}${msg}`,
      param: deriveFromLoc(loc),
      request_id: requestIdFromHeader,
      raw,
    };
  }

  if (isRecord(detail)) {
    const code =
      stringValue(detail.code) ?? stringValue(detail.status) ?? genericCodeFromStatus(httpStatus);
    return {
      type: stringValue(detail.type) ?? classifyTypeFromStatus(httpStatus),
      code,
      message: stringValue(detail.message) ?? stringValue(detail.msg) ?? statusText(httpStatus),
      param: stringValue(detail.param) ?? null,
      request_id: stringValue(detail.request_id) ?? requestIdFromHeader,
      raw,
    };
  }

  if (typeof detail === "string") {
    return {
      type: classifyTypeFromStatus(httpStatus),
      code: genericCodeFromStatus(httpStatus),
      message: detail,
      param: null,
      request_id: requestIdFromHeader,
      raw,
    };
  }

  const object = asRecord(body);
  return {
    type: classifyTypeFromStatus(httpStatus),
    code: stringValue(object.code) ?? genericCodeFromStatus(httpStatus),
    message: stringValue(object.message) ?? statusText(httpStatus),
    param: null,
    request_id: stringValue(object.request_id) ?? requestIdFromHeader,
    raw,
  };
}

function genericCodeFromStatus(status: number): string {
  if (status === 400) return "invalid_parameters";
  if (status === 401) return "invalid_api_key";
  if (status === 402) return "insufficient_credits";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 422) return "validation_error";
  if (status === 429) return "rate_limit_exceeded";
  if (status === 500) return "internal_error";
  if (status === 502 || status === 503 || status === 504) return "service_unavailable";
  return `http_${status}`;
}

function detailValue(body: unknown): unknown {
  return isRecord(body) && "detail" in body ? body.detail : body;
}

function deriveFromLoc(loc: unknown[]): string | null {
  for (let index = loc.length - 1; index >= 0; index -= 1) {
    const value = loc[index];
    if (typeof value !== "string" && typeof value !== "number") continue;
    const text = String(value);
    if (!["body", "query", "path", "header", "headers"].includes(text)) return text;
  }
  return null;
}

function header(headers: Headers, name: string): string | null {
  return headers.get(name) ?? null;
}

function statusText(status: number): string {
  if (status === 400) return "Bad request";
  if (status === 401) return "Unauthorized";
  if (status === 402) return "Payment required";
  if (status === 403) return "Forbidden";
  if (status === 404) return "Not found";
  if (status === 409) return "Conflict";
  if (status === 422) return "Validation error";
  if (status === 429) return "Rate limit exceeded";
  if (status >= 500) return "Provider server error";
  return `HTTP ${status}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
