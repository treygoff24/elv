import { extname, join } from "node:path";
import { Readable } from "node:stream";
import { extension } from "mime-types";
import { GUARDED_HINTS } from "./budget";
import { failure, success } from "./envelope";
import { mergeErrorHints } from "./errors";
import { normalizeProviderError } from "./error-normalizer";
import {
  deriveFilename,
  fileRecord,
  resolveOutTarget,
  streamToFile,
  tempFileWriter,
  writeBufferToFile,
} from "./files";
import { shellArg } from "../util/shell";
import type {
  CostInfo,
  DataSummary,
  Envelope,
  FileRecord,
  Hint,
  HttpMethod,
  OperationCard,
  SuccessEnvelope,
  Warning,
} from "./types";

export interface ResponseContext {
  cmd: string;
  out?: string;
  hash?: boolean;
  creditsEstimated?: number | null;
  requestPath?: string;
  method?: HttpMethod;
  inline?: boolean;
}

export const SMALL_JSON_LIMIT = 32 * 1024;

export async function normalizeResponse(
  op: OperationCard,
  res: Response,
  ctx: ResponseContext,
): Promise<Envelope> {
  const warnings: Warning[] = [];
  const http = {
    status: res.status,
    method: ctx.method ?? op.method,
    path: ctx.requestPath ?? op.pathTemplate,
  };

  if (!res.ok) {
    const body = await parseErrorBody(res);
    const error = normalizeProviderError(body, res.status, res.headers);
    return failure({
      cmd: ctx.cmd,
      operation_id: op.operationId,
      http,
      error,
      retry: {
        recommended: res.status === 429 || res.status >= 500,
        after_ms: retryAfterMs(res.headers),
      },
      hints: mergeErrorHints(
        error.type === "validation_error"
          ? [{ cmd: `elv ops schema ${op.operationId}`, why: "Inspect required params." }]
          : [],
        error,
        op.operationId,
        ctx.cmd,
      ),
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
      current:
        intHeader(res.headers, "current-concurrent-requests") ?? intHeader(res.headers, "current"),
      max:
        intHeader(res.headers, "maximum-concurrent-requests") ?? intHeader(res.headers, "maximum"),
    },
    cost,
  };

  const runtimeType = contentType(res.headers);
  return normalizeSuccessResponse(op, res, ctx, base, warnings, runtimeType);
}

async function normalizeSuccessResponse(
  op: OperationCard,
  res: Response,
  ctx: ResponseContext,
  base: Omit<SuccessEnvelope, "v" | "ok">,
  warnings: Warning[],
  runtimeType: string,
): Promise<Envelope> {
  if (op.streamKind === "json_events") {
    const files = await streamJsonEventsFiles(op, res, ctx);
    return success({ ...base, files, truncated: false, warnings: optional(warnings), hints: [] });
  }

  if (
    isBinary(runtimeType) ||
    (!isJson(runtimeType) && declaredBinary(op)) ||
    op.streamKind === "audio_bytes"
  ) {
    const files = [
      await streamResponseFile(
        op,
        res,
        ctx,
        runtimeType || declaredContentType(op) || "application/octet-stream",
      ),
    ];
    return success({ ...base, files, truncated: false, warnings: optional(warnings), hints: [] });
  }

  if (op.streamKind === "text" || isText(runtimeType)) {
    const files = [await streamResponseFile(op, res, ctx, runtimeType || "text/plain")];
    return success({ ...base, files, truncated: false, warnings: optional(warnings), hints: [] });
  }

  if (isJson(runtimeType) || (!runtimeType && op.returnsJson)) {
    const text = await res.text();
    const data = parseJson(text);
    if (isFullTimestampResponse(op, data)) {
      const files = await writeFullTimestampFiles(op, data, ctx);
      return success({ ...base, files, truncated: false, warnings: optional(warnings), hints: [] });
    }
    if (!ctx.inline && Buffer.byteLength(text) >= SMALL_JSON_LIMIT) {
      const file = await spillJsonFile(op, text, ctx);
      return success({
        ...base,
        data_summary: summarizeData(data),
        files: [file],
        truncated: true,
        warnings: optional(warnings),
        hints: [viewHint(file.path, data)],
      });
    }
    return success({
      ...base,
      data,
      truncated: false,
      warnings: optional(warnings),
      hints: [],
    });
  }

  const files = [await streamResponseFile(op, res, ctx, runtimeType || "application/octet-stream")];
  return success({ ...base, files, truncated: false, warnings: optional(warnings), hints: [] });
}

async function spillJsonFile(
  op: OperationCard,
  text: string,
  ctx: ResponseContext,
): Promise<FileRecord> {
  const target = resolveOutTarget(ctx.out, false);
  const filename = target.file ?? deriveFilename(op.operationId, "response", "json");
  const path = await writeBufferToFile(`${text}\n`, join(target.dir, filename));
  return { ...(await fileRecord(path, { hash: ctx.hash })), mime: "application/json" };
}

function viewHint(filePath: string, data: unknown): Hint {
  const pathHint = viewPathHint(data);
  return {
    cmd: `elv view ${shellArg(filePath)}${pathHint ? ` --path ${shellArg(pathHint)}` : ""}`,
    why: "Inspect spilled JSON without loading it into context.",
  };
}

/**
 * Spill an already-built success envelope's data when it is too large to inline, keeping only
 * the small pagination cursor (`next`) inline. Runs after pagination processing so the `next`
 * command and item truncation survive even when the page itself exceeds the inline limit.
 */
export function spillIfLarge(
  op: OperationCard,
  env: Envelope,
  ctx: { cmd: string; out?: string; saveJson?: string; hash?: boolean },
): Promise<Envelope> {
  if (!env.ok || env.data === undefined) return Promise.resolve(env);
  const text = JSON.stringify(env.data);
  const tooLarge = Buffer.byteLength(text) >= SMALL_JSON_LIMIT;
  if (!tooLarge && ctx.saveJson === undefined) return Promise.resolve(env);

  return spillEnvelopeData(op, env, ctx, text, tooLarge);
}

async function spillEnvelopeData(
  op: OperationCard,
  env: SuccessEnvelope,
  ctx: { cmd: string; out?: string; saveJson?: string; hash?: boolean },
  text: string,
  tooLarge: boolean,
): Promise<Envelope> {
  const file = await spillJsonFile(op, text, {
    cmd: ctx.cmd,
    out: ctx.saveJson ?? ctx.out,
    hash: ctx.hash,
  });
  if (!tooLarge) return { ...env, files: [...(env.files ?? []), file] };

  return {
    ...env,
    data: paginationNext(env.data),
    data_summary: summarizeData(env.data),
    files: [...(env.files ?? []), file],
    truncated: true,
    hints: [viewHint(file.path, env.data)],
  };
}

function paginationNext(data: unknown): Record<string, unknown> | undefined {
  if (isRecord(data) && data.next !== undefined) return { next: data.next };
  return undefined;
}

// Cap the array preview by serialized size so a summary of large objects stays small —
// the whole point of spilling is to avoid loading the bulky payload into context.
const PREVIEW_MAX_ITEMS = 20;
const PREVIEW_MAX_BYTES = 4 * 1024;

function boundedPreview(items: unknown[]): unknown[] {
  const preview: unknown[] = [];
  let bytes = 0;
  for (const item of items.slice(0, PREVIEW_MAX_ITEMS)) {
    const size = JSON.stringify(item)?.length ?? 0;
    if (preview.length > 0 && bytes + size > PREVIEW_MAX_BYTES) break;
    preview.push(item);
    bytes += size;
  }
  return preview;
}

export function summarizeData(data: unknown): DataSummary {
  if (Array.isArray(data)) {
    const preview = boundedPreview(data);
    return { type: "array", count: data.length, preview_count: preview.length, preview };
  }
  if (isRecord(data)) {
    const keys = Object.keys(data).slice(0, 20);
    return {
      type: "object",
      count: Object.keys(data).length,
      preview_count: keys.length,
      preview: keys,
    };
  }
  return { type: data === null ? "null" : typeof data };
}

function viewPathHint(data: unknown): string {
  if (Array.isArray(data)) return "";
  if (isRecord(data)) return Object.keys(data)[0] ?? "";
  return "";
}

async function writeFullTimestampFiles(
  op: OperationCard,
  data: Record<string, unknown>,
  ctx: ResponseContext,
): Promise<FileRecord[]> {
  const target = resolveOutTarget(ctx.out, false);
  const audioName =
    target.file ??
    deriveFilename(op.operationId, "audio", audioExtensionFromRequestPath(ctx.requestPath));
  const audioPath = await writeBufferToFile(
    Buffer.from(String(data.audio_base64), "base64"),
    join(target.dir, audioName),
  );
  const sidecar = {
    alignment: data.alignment,
    normalized_alignment: data.normalized_alignment,
  };
  const sidecarPath = await writeBufferToFile(
    `${JSON.stringify(sidecar)}\n`,
    timestampSidecarPath(audioPath),
  );
  return [
    await fileRecord(audioPath, { hash: ctx.hash }),
    { ...(await fileRecord(sidecarPath, { hash: ctx.hash })), mime: "application/json" },
  ];
}

function isFullTimestampResponse(
  op: OperationCard,
  data: unknown,
): data is Record<string, unknown> {
  return (
    op.operationId.endsWith("_full_with_timestamps") &&
    isRecord(data) &&
    typeof data.audio_base64 === "string"
  );
}

function timestampSidecarPath(audioPath: string): string {
  const ext = extname(audioPath);
  return ext
    ? `${audioPath.slice(0, -ext.length)}.timestamps.json`
    : `${audioPath}.timestamps.json`;
}

async function streamJsonEventsFiles(
  op: OperationCard,
  res: Response,
  ctx: ResponseContext,
): Promise<FileRecord[]> {
  const target = resolveOutTarget(ctx.out, true);
  const ndjson = tempFileWriter(
    join(target.dir, deriveFilename(op.operationId, undefined, "ndjson")),
  );
  let audio: ReturnType<typeof tempFileWriter> | undefined;
  const decoder = new TextDecoder();
  let pending = "";

  try {
    for await (const chunk of toNodeReadable(res.body ?? Readable.from([]))) {
      pending += decoder.decode(chunkBuffer(chunk), { stream: true });
      const parsed = extractJsonObjects(pending);
      pending = parsed.rest;
      for (const event of parsed.objects)
        await writeJsonEvent(
          event,
          ndjson,
          () => (audio ??= jsonEventsAudioWriter(op, ctx, target.dir)),
        );
    }

    pending += decoder.decode();
    const parsed = extractJsonObjects(pending);
    if (parsed.rest.trim()) throw new Error("Incomplete trailing JSON event");
    for (const event of parsed.objects)
      await writeJsonEvent(
        event,
        ndjson,
        () => (audio ??= jsonEventsAudioWriter(op, ctx, target.dir)),
      );

    const ndjsonPath = await ndjson.close();
    const files: FileRecord[] = [
      { ...(await fileRecord(ndjsonPath, { hash: ctx.hash })), mime: "application/x-ndjson" },
    ];
    if (audio) {
      const audioPath = await audio.close();
      files.push(await fileRecord(audioPath, { hash: ctx.hash }));
    }
    return files;
  } catch (error) {
    await ndjson.abort();
    if (audio) await audio.abort();
    throw error;
  }
}

function jsonEventsAudioWriter(
  op: OperationCard,
  ctx: ResponseContext,
  dir: string,
): ReturnType<typeof tempFileWriter> {
  const ext = audioExtensionFromRequestPath(ctx.requestPath);
  return tempFileWriter(join(dir, deriveFilename(op.operationId, "audio", ext)));
}

async function writeJsonEvent(
  event: unknown,
  ndjson: ReturnType<typeof tempFileWriter>,
  audioWriter: () => ReturnType<typeof tempFileWriter>,
): Promise<void> {
  await ndjson.write(`${JSON.stringify(event)}\n`);
  if (!isRecord(event)) return;
  const audio = typeof event.audio_base64 === "string" ? event.audio_base64 : event.audio;
  if (typeof audio === "string" && audio.length > 0)
    await audioWriter().write(Buffer.from(audio, "base64"));
}

function extractJsonObjects(text: string): { objects: unknown[]; rest: string } {
  const objects: unknown[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (start === -1) {
      if (char === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\\\") {
      escaped = inString;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;

    if (depth === 0) {
      objects.push(parseJson(text.slice(start, index + 1)));
      start = -1;
      inString = false;
    }
  }

  return { objects, rest: start === -1 ? "" : text.slice(start) };
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

function chunkBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (typeof chunk === "string") return Buffer.from(chunk);
  return Buffer.from(String(chunk));
}

function toNodeReadable(body: globalThis.ReadableStream | Readable): Readable {
  if (body instanceof Readable) return body;
  return Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
}

function audioExtensionFromRequestPath(path: string | undefined): string {
  if (!path) return "mp3";
  const outputFormat = new URL(path, "https://elv.local").searchParams.get("output_format") ?? "";
  const codec = outputFormat.split("_")[0];
  if (codec === "pcm" || codec === "ulaw" || codec === "alaw" || codec === "opus") return codec;
  return "mp3";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  if (estimated !== null || (op.costHint && GUARDED_HINTS.has(op.costHint))) {
    warnings.push({
      code: "cost_header_absent",
      message: "Provider did not return character-cost; credits_charged is unavailable.",
    });
    return {
      credits_estimated: estimated,
      credits_charged: null,
      credits_source: estimated === null ? "none" : "estimate",
    };
  }
  return { credits_estimated: null, credits_charged: null, credits_source: "none" };
}

async function parseErrorBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  if (isJson(contentType(res.headers))) {
    try {
      return parseJson(text);
    } catch (error) {
      return {
        detail: text,
        parse_error: error instanceof Error ? error.message : String(error),
      };
    }
  }
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
  return (
    op.responses.find((response) => response.status === "200")?.contentType ??
    op.responses[0]?.contentType
  );
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
