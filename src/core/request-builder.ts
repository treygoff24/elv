import { openAsBlob, statSync } from "node:fs";
import { basename } from "node:path";
import { lookup } from "mime-types";
import type { AgentInput, HttpMethod, NormalizedError, OperationCard } from "./types";

// Multipart uses the native global FormData + fs.openAsBlob (lazy, file-backed) rather than the
// `form-data` package: form-data's Node stream is not transmitted by native fetch/undici (the body
// arrives empty), whereas a FormData with an openAsBlob-backed Blob streams without buffering the
// whole file into memory — required for large dubbing uploads (spec §6).

export interface NormalizeInputOptions {
  allowUnknown?: boolean;
}

export interface BuildRequestContext {
  baseUrl?: string;
  apiKey?: string;
  maxUploadBytes?: number;
}

export interface HttpRequest {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body?: string | FormData;
  duplex?: "half";
  path: string;
}

const DEFAULT_BASE_URL = "https://api.elevenlabs.io";
const DEFAULT_MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const BUCKET_KEYS = new Set(["path", "query", "body", "headers", "files"]);

export class InputNormalizationError extends Error {
  readonly detail: NormalizedError;

  constructor(message: string, raw?: unknown, param?: string | null) {
    super(message);
    this.name = "InputNormalizationError";
    this.detail = {
      type: "validation_error",
      code: "validation_error",
      message,
      param: param ?? null,
      raw,
    };
  }

  toNormalizedError(): NormalizedError {
    return this.detail;
  }
}

export function normalizeInput(
  op: OperationCard,
  input: AgentInput | Record<string, unknown>,
  options: NormalizeInputOptions = {},
): AgentInput {
  const source = asRecord(input);
  const normalized: AgentInput = {};

  if ("path" in source) normalized.path = copyRecord(source.path, "path");
  if ("query" in source) normalized.query = copyRecord(source.query, "query");
  if ("headers" in source) normalized.headers = stringifyRecord(source.headers, "headers");
  if ("files" in source) normalized.files = copyFiles(source.files);
  if ("body" in source) normalized.body = source.body;

  for (const [key, value] of Object.entries(source)) {
    if (BUCKET_KEYS.has(key)) continue;
    routeFlatKey(op, normalized, key, value, options);
  }

  return compactInput(normalized);
}

export function buildHttpRequest(
  op: OperationCard,
  normalized: AgentInput,
  ctx: BuildRequestContext = {},
): Promise<HttpRequest> {
  const path = resolvePath(op, normalized.path ?? {});
  const url = new URL(path, ctx.baseUrl ?? DEFAULT_BASE_URL);
  for (const [key, value] of Object.entries(normalized.query ?? {})) appendQuery(url, key, value);

  const headers: Record<string, string> = { ...normalized.headers };
  if (ctx.apiKey) headers["xi-api-key"] = ctx.apiKey;

  let body: string | FormData | undefined;
  if (op.requestBody || normalized.body !== undefined) {
    const contentType = op.requestBody?.contentType ?? "application/json";
    if (op.requestBody?.multipart || contentType.toLowerCase().includes("multipart/form-data")) {
      // Do NOT set content-type: fetch derives multipart/form-data + boundary from the FormData body.
      return buildMultipartRequest(op, normalized, ctx, url, headers, path);
    }
    headers["content-type"] = contentType;
    body = serializeBody(contentType, normalized.body ?? {});
  }

  return Promise.resolve({ url: url.toString(), method: op.method, headers, body, path });
}

async function buildMultipartRequest(
  op: OperationCard,
  normalized: AgentInput,
  ctx: BuildRequestContext,
  url: URL,
  headers: Record<string, string>,
  path: string,
): Promise<HttpRequest> {
  return {
    url: url.toString(),
    method: op.method,
    headers,
    body: await buildMultipartBody(op, normalized, ctx),
    path,
  };
}

function routeFlatKey(
  op: OperationCard,
  normalized: AgentInput,
  key: string,
  value: unknown,
  options: NormalizeInputOptions,
): void {
  const matches = locationsForKey(op, key);
  if (matches.length === 0) {
    if (options.allowUnknown) {
      putBody(normalized, key, value);
      return;
    }
    throw new InputNormalizationError(
      `Unknown input key "${key}"`,
      { key, bucketed_shape: {} },
      key,
    );
  }
  if (matches.length > 1) {
    throw new InputNormalizationError(
      `Ambiguous input key "${key}" matches ${matches.join(", ")}`,
      { key, matches, bucketed_shape: bucketedShapeForAmbiguity(matches, key, value) },
      key,
    );
  }

  const match = matches[0];
  if (match === "path") normalized.path = { ...normalized.path, [key]: value };
  else if (match === "query") normalized.query = { ...normalized.query, [key]: value };
  else if (match === "header") normalized.headers = { ...normalized.headers, [key]: String(value) };
  else putBody(normalized, key, value);
}

function locationsForKey(
  op: OperationCard,
  key: string,
): Array<"path" | "query" | "header" | "body"> {
  const matches: Array<"path" | "query" | "header" | "body"> = [];
  if (op.pathParams.some((param) => param.name === key)) matches.push("path");
  if (op.queryParams.some((param) => param.name === key)) matches.push("query");
  if (op.headerParams.some((param) => param.name === key)) matches.push("header");
  if (bodyFieldNames(op).has(key)) matches.push("body");
  return matches;
}

function bodyFieldNames(op: OperationCard): Set<string> {
  const properties = asRecord(asRecord(op.requestBody?.schema).properties);
  return new Set(Object.keys(properties));
}

async function buildMultipartBody(
  op: OperationCard,
  normalized: AgentInput,
  ctx: BuildRequestContext,
): Promise<FormData> {
  const form = new FormData();
  const fileFields = new Set(op.requestBody?.fileFields ?? []);
  const files = normalized.files ?? {};
  const bodyRecord = normalized.body === undefined ? {} : asRecord(normalized.body);

  for (const [field, value] of Object.entries(bodyRecord)) {
    if (fileFields.has(field)) continue;
    appendFormValue(form, field, value);
  }

  for (const [field, value] of Object.entries(files)) {
    if (!fileFields.has(field)) {
      throw new InputNormalizationError(
        `Unknown file field "${field}" for ${op.operationId}`,
        undefined,
        field,
      );
    }
    for (const path of Array.isArray(value) ? value : [value]) {
      await appendFile(form, field, path, ctx);
    }
  }

  return form;
}

function appendFormValue(form: FormData, field: string, value: unknown): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) appendFormValue(form, field, item);
    return;
  }
  if (value === null) {
    form.append(field, "");
    return;
  }
  if (typeof value === "object") {
    form.append(field, JSON.stringify(value));
    return;
  }
  form.append(field, String(value));
}

async function appendFile(
  form: FormData,
  field: string,
  path: string,
  ctx: BuildRequestContext,
): Promise<void> {
  const stats = statSync(path);
  const cap = uploadCapBytes(ctx);
  if (stats.size > cap) {
    throw new InputNormalizationError(
      `Upload file "${field}" exceeds max upload size (${stats.size} > ${cap} bytes)`,
      { field, path, bytes: stats.size, max_bytes: cap },
      field,
    );
  }
  // openAsBlob is lazy/file-backed — it does not read the whole file into memory.
  const blob = await openAsBlob(path, { type: lookup(path) || "application/octet-stream" });
  form.append(field, blob, basename(path));
}

function uploadCapBytes(ctx: BuildRequestContext): number {
  const envValue = Number(process.env.ELV_MAX_UPLOAD_BYTES);
  if (ctx.maxUploadBytes !== undefined) return ctx.maxUploadBytes;
  return Number.isFinite(envValue) && envValue > 0 ? envValue : DEFAULT_MAX_UPLOAD_BYTES;
}

function putBody(normalized: AgentInput, key: string, value: unknown): void {
  if (normalized.body === undefined) normalized.body = {};
  const body = normalized.body;
  if (!isPlainObject(body)) {
    throw new InputNormalizationError(
      `Cannot merge flat key "${key}" into non-object body`,
      undefined,
      key,
    );
  }
  normalized.body = { ...body, [key]: value };
}

function bucketedShapeForAmbiguity(
  matches: Array<"path" | "query" | "header" | "body">,
  key: string,
  value: unknown,
): AgentInput {
  const shape: AgentInput = { path: {}, query: {}, headers: {}, body: {} };
  if (matches.includes("path")) shape.path = { [key]: value };
  if (matches.includes("query")) shape.query = { [key]: value };
  if (matches.includes("header")) shape.headers = { [key]: String(value) };
  if (matches.includes("body")) shape.body = { [key]: value };
  return shape;
}

function resolvePath(op: OperationCard, pathInput: Record<string, unknown>): string {
  return op.pathTemplate.replace(/\{([^}]+)\}/gu, (_, name: string) => {
    const value = pathInput[name];
    if (value === undefined || value === null || value === "") {
      throw new InputNormalizationError(
        `Missing required path parameter "${name}"`,
        undefined,
        name,
      );
    }
    return encodeURIComponent(String(value));
  });
}

function appendQuery(url: URL, key: string, value: unknown): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) if (item !== undefined) url.searchParams.append(key, String(item));
    return;
  }
  url.searchParams.append(key, value === null ? "" : String(value));
}

function serializeBody(contentType: string, body: unknown): string {
  const lower = contentType.toLowerCase();
  if (lower.includes("json")) return JSON.stringify(body);
  if (typeof body === "string") return body;
  return JSON.stringify(body);
}

function compactInput(input: AgentInput): AgentInput {
  const out: AgentInput = {};
  if (input.path && Object.keys(input.path).length > 0) out.path = input.path;
  if (input.query && Object.keys(input.query).length > 0) out.query = input.query;
  if (input.headers && Object.keys(input.headers).length > 0) out.headers = input.headers;
  if (input.files && Object.keys(input.files).length > 0) out.files = input.files;
  if (input.body !== undefined) out.body = input.body;
  return out;
}

function copyRecord(value: unknown, bucket: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw new InputNormalizationError(`${bucket} must be an object`);
  return { ...value };
}

function stringifyRecord(value: unknown, bucket: string): Record<string, string> {
  const record = copyRecord(value, bucket);
  return Object.fromEntries(Object.entries(record).map(([key, val]) => [key, String(val)]));
}

function copyFiles(value: unknown): Record<string, string | string[]> {
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw new InputNormalizationError("files must be an object");
  const out: Record<string, string | string[]> = {};
  for (const [key, val] of Object.entries(value)) {
    const field = key.endsWith("[]") ? key.slice(0, -2) : key;
    if (!field) throw new InputNormalizationError(`files.${key} must name a field`, undefined, key);
    if (typeof val === "string") mergeFile(out, field, key.endsWith("[]") ? [val] : val);
    else if (Array.isArray(val) && val.every((item) => typeof item === "string"))
      mergeFile(out, field, val);
    else
      throw new InputNormalizationError(
        `files.${key} must be a path string or path string array`,
        undefined,
        key,
      );
  }
  return out;
}

function mergeFile(
  out: Record<string, string | string[]>,
  field: string,
  value: string | string[],
): void {
  const previous = out[field];
  if (previous === undefined) {
    out[field] = value;
    return;
  }
  out[field] = [
    ...(Array.isArray(previous) ? previous : [previous]),
    ...(Array.isArray(value) ? value : [value]),
  ];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) throw new InputNormalizationError("Input JSON must be an object");
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
