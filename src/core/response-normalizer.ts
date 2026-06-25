import { join } from "node:path";
import { Readable } from "node:stream";
import { extension } from "mime-types";
import { failure, success } from "./envelope";
import { normalizeProviderError } from "./error-normalizer";
import { deriveFilename, fileRecord, resolveOutTarget, streamToFile } from "./files";
import type { CostInfo, Envelope, FileRecord, HttpMethod, OperationCard, Warning } from "./types";

export interface ResponseContext {
  cmd: string;
  out?: string;
  hash?: boolean;
  creditsEstimated?: number | null;
  requestPath?: string;
  method?: HttpMethod;
}

const SMALL_JSON_LIMIT = 32 * 1024;

export async function normalizeResponse(
  op: OperationCard,
  res: Response,
  ctx: ResponseContext,
): Promise<Envelope> {
  const warnings: Warning[] = [];
  const http = { status: res.status, method: ctx.method ?? op.method, path: ctx.requestPath ?? op.pathTemplate };

  if (!res.ok) {
    const body = await parseErrorBody(res);
    const error = normalizeProviderError(body, res.status, res.headers);
    return failure({
      cmd: ctx.cmd,
      operation_id: op.operationId,
      http,
      error,
      retry: { recommended: res.status === 429 || res.status >= 500, after_ms: retryAfterMs(res.headers) },
      hints: error.type === "validation_error" ? [{ cmd: `elv ops schema ${op.operationId}`, why: "Inspect required params." }] : [],
    });
  }

  const cost = costInfo(op, res.headers, ctx.creditsEstimated ?? null, warnings);
  const base = {
    cmd: ctx.cmd,
    operation_id: op.operationId,
    http,
    request: {
      id: res.headers.get("request-id"),
      trace_id: res.headers.get("x-trace-id"),
      song_id: res.headers.get("song-id"),
    },
    concurrency: {
      current: intHeader(res.headers, "current-concurrent-requests") ?? intHeader(res.headers, "current"),
      max: intHeader(res.headers, "maximum-concurrent-requests") ?? intHeader(res.headers, "maximum"),
    },
    cost,
  };

  const runtimeType = contentType(res.headers);
  if (op.streamKind === "json_events") {
    warnings.push({
      code: "json_events_p4",
      message: "json_events parsing lands in P4; response is preserved as JSON/text and never piped as audio.",
    });
  }

  if (
    op.streamKind !== "json_events" &&
    (isBinary(runtimeType) || (!isJson(runtimeType) && declaredBinary(op)) || op.streamKind === "audio_bytes")
  ) {
    const files = [await streamResponseFile(op, res, ctx, runtimeType || declaredContentType(op) || "application/octet-stream")];
    return success({ ...base, files, truncated: false, warnings: optional(warnings), hints: [] });
  }

  if (op.streamKind === "text" || isText(runtimeType)) {
    const files = [await streamResponseFile(op, res, ctx, runtimeType || "text/plain")];
    return success({ ...base, files, truncated: false, warnings: optional(warnings), hints: [] });
  }

  if (isJson(runtimeType) || (!runtimeType && op.returnsJson)) {
    const text = await res.text();
    if (Buffer.byteLength(text) >= SMALL_JSON_LIMIT) {
      // P4: spill large JSON to disk and leave only data_summary inline.
      warnings.push({ code: "large_json_spill_p4", message: "Large JSON spill lands in P4; data is inline for now." });
    }
    return success({
      ...base,
      data: parseJson(text),
      truncated: false,
      warnings: optional(warnings),
      hints: [],
    });
  }

  const files = [await streamResponseFile(op, res, ctx, runtimeType || "application/octet-stream")];
  return success({ ...base, files, truncated: false, warnings: optional(warnings), hints: [] });
}

async function streamResponseFile(
  op: OperationCard,
  res: Response,
  ctx: ResponseContext,
  mime: string,
): Promise<FileRecord> {
  const target = resolveOutTarget(ctx.out, false);
  const filename = target.file ?? deriveFilename(op.operationId, undefined, extensionForMime(mime));
  const path = join(target.dir, filename);
  const body = res.body ?? Readable.from([]);
  await streamToFile(body, path);
  const record = await fileRecord(path, { hash: ctx.hash });
  return { ...record, mime };
}

function costInfo(
  op: OperationCard,
  headers: Headers,
  estimated: number | null,
  warnings: Warning[],
): CostInfo {
  const charged = numberHeader(headers, "character-cost");
  if (charged !== null) {
    return { credits_estimated: estimated, credits_charged: charged, credits_source: "header" };
  }
  if (estimated !== null || op.costHint) {
    warnings.push({
      code: "cost_header_absent",
      message: "Provider did not return character-cost; credits_charged is unavailable.",
    });
    return { credits_estimated: estimated, credits_charged: null, credits_source: estimated === null ? "none" : "estimate" };
  }
  return { credits_estimated: null, credits_charged: null, credits_source: "none" };
}

async function parseErrorBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  if (isJson(contentType(res.headers))) return parseJson(text);
  return { detail: text };
}

function parseJson(text: string): unknown {
  if (!text) return null;
  return JSON.parse(text) as unknown;
}

function declaredBinary(op: OperationCard): boolean {
  return op.returnsBinary || op.responses.some((response) => response.binary);
}

function declaredContentType(op: OperationCard): string | undefined {
  return op.responses.find((response) => response.status === "200")?.contentType ?? op.responses[0]?.contentType;
}

function contentType(headers: Headers): string {
  return (headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

function isJson(value: string): boolean {
  return value === "application/json" || value.endsWith("+json");
}

function isText(value: string): boolean {
  return value.startsWith("text/");
}

function isBinary(value: string): boolean {
  return (
    value.startsWith("audio/") ||
    value === "application/zip" ||
    value === "application/x-zip" ||
    value === "application/octet-stream" ||
    /^application\/.*zip/iu.test(value)
  );
}

function extensionForMime(mime: string): string {
  if (mime === "audio/mpeg") return "mp3";
  if (mime === "application/octet-stream") return "bin";
  if (mime === "application/zip" || mime === "application/x-zip") return "zip";
  if (mime === "text/plain") return "txt";
  return extension(mime) || "bin";
}

function intHeader(headers: Headers, name: string): number | null {
  const value = numberHeader(headers, name);
  return value === null ? null : Math.trunc(value);
}

function numberHeader(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function retryAfterMs(headers: Headers): number | null {
  const value = headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

function optional<T>(items: T[]): T[] | undefined {
  return items.length > 0 ? items : undefined;
}
