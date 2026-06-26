import { classifyTypeFromStatus } from "./errors";
import type { NormalizedError } from "./types";

interface ProviderErrorContext {
  httpStatus: number;
  requestIdFromHeader: string | null;
  raw: unknown;
}

const CODE_BY_STATUS: Record<number, string> = {
  400: "invalid_parameters",
  401: "invalid_api_key",
  402: "insufficient_credits",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  422: "validation_error",
  429: "rate_limit_exceeded",
  500: "internal_error",
};

const TEXT_BY_STATUS: Record<number, string> = {
  400: "Bad request",
  401: "Unauthorized",
  402: "Payment required",
  403: "Forbidden",
  404: "Not found",
  409: "Conflict",
  422: "Validation error",
  429: "Rate limit exceeded",
};

export function normalizeProviderError(
  body: unknown,
  httpStatus: number,
  headers: Headers,
): NormalizedError {
  return normalizeDetail(detailValue(body), {
    httpStatus,
    requestIdFromHeader: header(headers, "request-id"),
    raw: body,
  });
}

function normalizeDetail(detail: unknown, context: ProviderErrorContext): NormalizedError {
  if (Array.isArray(detail)) {
    return normalizeArrayDetail(detail, context);
  }
  if (isRecord(detail)) {
    return normalizeObjectDetail(detail, context);
  }
  if (typeof detail === "string") {
    return normalizeStringDetail(detail, context);
  }
  return normalizeObjectDetail(asRecord(context.raw), context);
}

function normalizeArrayDetail(detail: unknown[], context: ProviderErrorContext): NormalizedError {
  const first = asRecord(detail[0]);
  const loc = Array.isArray(first.loc) ? first.loc : [];
  const msg = stringValue(first.msg) ?? statusText(context.httpStatus);
  const prefix = typeof loc[0] === "string" ? `${loc[0]}: ` : "";
  return {
    type: classifyTypeFromStatus(context.httpStatus),
    code: "validation_error",
    message: `${prefix}${msg}`,
    param: deriveFromLoc(loc),
    request_id: context.requestIdFromHeader,
    raw: context.raw,
  };
}

function normalizeObjectDetail(
  detail: Record<string, unknown>,
  context: ProviderErrorContext,
): NormalizedError {
  return {
    type: stringValue(detail.type) ?? classifyTypeFromStatus(context.httpStatus),
    code:
      stringValue(detail.code) ??
      stringValue(detail.status) ??
      genericCodeFromStatus(context.httpStatus),
    message:
      stringValue(detail.message) ?? stringValue(detail.msg) ?? statusText(context.httpStatus),
    param: stringValue(detail.param) ?? null,
    request_id: stringValue(detail.request_id) ?? context.requestIdFromHeader,
    raw: context.raw,
  };
}

function normalizeStringDetail(detail: string, context: ProviderErrorContext): NormalizedError {
  return {
    type: classifyTypeFromStatus(context.httpStatus),
    code: genericCodeFromStatus(context.httpStatus),
    message: detail,
    param: null,
    request_id: context.requestIdFromHeader,
    raw: context.raw,
  };
}

function genericCodeFromStatus(status: number): string {
  return CODE_BY_STATUS[status] ?? serviceUnavailableCode(status) ?? `http_${status}`;
}

function serviceUnavailableCode(status: number): string | undefined {
  return status === 502 || status === 503 || status === 504 ? "service_unavailable" : undefined;
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
  return TEXT_BY_STATUS[status] ?? (status >= 500 ? "Provider server error" : `HTTP ${status}`);
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
