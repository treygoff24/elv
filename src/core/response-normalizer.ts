import { extname, join } from "node:path";
import { Readable } from "node:stream";
import { extension } from "mime-types";
import { GUARDED_HINTS } from "./budget";
import { decodeBase64 } from "./encoding";
import { failure, success } from "./envelope";
import { mergeErrorHints } from "./errors";
import { normalizeProviderError } from "./error-normalizer";
import {
  deriveFilename,
  fileRecord,
  resolveOutTarget,
  streamToFile,
  tempFileWriter,
  toNodeReadable,
  writeBufferToFile,
} from "./files";
import { isRecord, parseJson as parseJsonValue } from "../util/json";
import { shellArg } from "../util/shell";
import { containsCredential } from "./redaction";
import type { HttpMethod, OperationCard } from "../openapi/types";
import type {
  CostInfo,
  DataSummary,
  Envelope,
  FileRecord,
  Hint,
  RunOpts,
  SuccessEnvelope,
  Warning,
} from "./types";

export interface ResponseContext extends Pick<RunOpts, "out" | "hash"> {
  cmd: string;
  creditsEstimated?: number | null;
  requestPath?: string;
  method?: HttpMethod;
  inline?: boolean;
  saveJson?: string;
}

type JsonSpillContext = Pick<ResponseContext, "cmd" | "out" | "hash"> & { saveJson?: string };

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
    return streamJsonEventsResponse(op, res, ctx, base, warnings);
  }

  if (op.streamKind === "sse_events") {
    return streamSseEventsResponse(op, res, ctx, base, warnings);
  }

  if (isBinarySuccess(op, runtimeType)) {
    return streamFileSuccess(
      op,
      res,
      ctx,
      base,
      warnings,
      runtimeType || declaredContentType(op) || "application/octet-stream",
    );
  }

  if (op.streamKind === "text" || isText(runtimeType)) {
    return streamFileSuccess(op, res, ctx, base, warnings, runtimeType || "text/plain");
  }

  if (isJson(runtimeType) || (!runtimeType && op.returnsJson)) {
    return jsonSuccess(op, res, ctx, base, warnings);
  }

  return streamFileSuccess(op, res, ctx, base, warnings, runtimeType || "application/octet-stream");
}

async function streamFileSuccess(
  op: OperationCard,
  res: Response,
  ctx: ResponseContext,
  base: Omit<SuccessEnvelope, "v" | "ok">,
  warnings: Warning[],
  mime: string,
): Promise<Envelope> {
  const files = [await streamResponseFile(op, res, ctx, mime)];
  return fileSuccess(base, files, warnings);
}

function fileSuccess(
  base: Omit<SuccessEnvelope, "v" | "ok">,
  files: FileRecord[],
  warnings: Warning[],
): Envelope {
  return success({ ...base, files, truncated: false, warnings: optional(warnings), hints: [] });
}

async function jsonSuccess(
  op: OperationCard,
  res: Response,
  ctx: ResponseContext,
  base: Omit<SuccessEnvelope, "v" | "ok">,
  warnings: Warning[],
): Promise<Envelope> {
  const text = await res.text();
  let data: unknown;
  try {
    data = parseOptionalJsonBody(text);
  } catch (error) {
    return invalidJsonSuccess(op, ctx, base, warnings, text, error);
  }
  if (op.secretResult || containsCredential(data)) {
    const file = await spillSecretJsonFile(op, text, ctx);
    return success({
      ...base,
      data_summary: summarizeSensitiveData(data),
      files: [{ ...file, sensitive: true }],
      truncated: true,
      warnings: optional(warnings),
      hints: [
        {
          cmd: `cat ${shellArg(file.path)}`,
          why: "Read the credential directly; elv view refuses sensitive provider responses.",
        },
      ],
    });
  }
  if (isFullTimestampResponse(op, data)) {
    const files = await writeFullTimestampFiles(op, data, ctx);
    return fileSuccess(base, files, warnings);
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

function invalidJsonSuccess(
  op: OperationCard,
  ctx: ResponseContext,
  base: Omit<SuccessEnvelope, "v" | "ok">,
  warnings: Warning[],
  body: string,
  error: unknown,
): Envelope {
  const parseError = error instanceof Error ? error.message : String(error);
  return failure({
    cmd: ctx.cmd,
    operation_id: op.operationId,
    http: base.http,
    error: {
      type: "provider_error",
      code: "invalid_json_response",
      message: "Provider returned invalid JSON response",
      raw: {
        status: base.http?.status,
        path: base.http?.path,
        parse_error: parseError,
        body: previewText(body),
      },
    },
    retry: { recommended: false, after_ms: null },
    cost: base.cost,
    warnings: optional(warnings),
    hints: [],
  });
}

function isBinarySuccess(op: OperationCard, runtimeType: string): boolean {
  return (
    isBinary(runtimeType) ||
    (!isJson(runtimeType) && declaredBinary(op)) ||
    op.streamKind === "audio_bytes"
  );
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

async function spillSecretJsonFile(
  op: OperationCard,
  text: string,
  ctx: ResponseContext,
): Promise<FileRecord> {
  const target = resolveOutTarget(ctx.saveJson ?? ctx.out, false);
  const filename = target.file ?? deriveFilename(op.operationId, "sensitive", "json");
  const path = await writeBufferToFile(`${text}\n`, join(target.dir, filename), { mode: 0o600 });
  return {
    ...(await fileRecord(path, { hash: ctx.hash })),
    mime: "application/json",
    sensitive: true,
  };
}

function summarizeSensitiveData(data: unknown): DataSummary {
  if (Array.isArray(data)) return { type: "array", count: data.length };
  if (isRecord(data)) return { type: "object", count: Object.keys(data).length };
  return { type: data === null ? "null" : typeof data };
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
  ctx: JsonSpillContext,
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
  ctx: JsonSpillContext,
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

interface SseFrame {
  event?: string;
  id?: string;
  retry?: number;
  data: string;
}

interface SseParserState {
  pending: string;
  lines: string[];
}

async function streamSseEventsResponse(
  op: OperationCard,
  res: Response,
  ctx: ResponseContext,
  base: Omit<SuccessEnvelope, "v" | "ok">,
  warnings: Warning[],
): Promise<Envelope> {
  const target = resolveOutTarget(ctx.out, true);
  const ndjson = tempFileWriter(
    join(target.dir, deriveFilename(op.operationId, undefined, "ndjson")),
  );
  let audio: ReturnType<typeof tempFileWriter> | undefined;
  let eventCount = 0;
  let audioBytes = 0;
  const parser: SseParserState = { pending: "", lines: [] };
  const decoder = new TextDecoder("utf-8", { fatal: true });

  try {
    for await (const chunk of toNodeReadable(res.body ?? Readable.from([]))) {
      const frames = feedSse(parser, decoder.decode(chunkBuffer(chunk), { stream: true }), false);
      for (const frame of frames) {
        const written = await writeSseFrame(
          frame,
          ndjson,
          () => (audio ??= jsonEventsAudioWriter(op, ctx, target.dir)),
          (bytes) => {
            audioBytes += bytes;
          },
        );
        if (written.event) eventCount += 1;
      }
    }

    const frames = feedSse(parser, decoder.decode(), true);
    for (const frame of frames) {
      const written = await writeSseFrame(
        frame,
        ndjson,
        () => (audio ??= jsonEventsAudioWriter(op, ctx, target.dir)),
        (bytes) => {
          audioBytes += bytes;
        },
      );
      if (written.event) eventCount += 1;
    }

    const files = await closeSseFiles(ndjson, audio, ctx, false);
    return fileSuccess(base, files, warnings);
  } catch (error) {
    return streamFailure(ctx, op, base, warnings, error, {
      ndjson,
      audio,
      eventCount,
      audioBytes,
      closeNdjson: () => closeSseFiles(ndjson, undefined, ctx, true),
      closeAudio: () => closeSseFiles(undefined, audio!, ctx, true),
      code: "invalid_sse_stream",
      message: "Provider returned a malformed SSE stream",
      noFilesHints: [],
    });
  }
}

async function closeSseFiles(
  ndjson: ReturnType<typeof tempFileWriter> | undefined,
  audio: ReturnType<typeof tempFileWriter> | undefined,
  ctx: ResponseContext,
  partial: boolean,
): Promise<FileRecord[]> {
  const files: FileRecord[] = [];
  if (ndjson) {
    const path = await ndjson.close();
    files.push({
      ...(await fileRecord(path, { hash: ctx.hash })),
      mime: "application/x-ndjson",
      ...(partial ? { partial: true } : {}),
    });
  }
  if (audio) {
    const path = await audio.close();
    files.push({
      ...(await fileRecord(path, { hash: ctx.hash })),
      ...(partial ? { partial: true } : {}),
    });
  }
  return files;
}

interface StreamFailureOptions {
  ndjson: ReturnType<typeof tempFileWriter>;
  audio: ReturnType<typeof tempFileWriter> | undefined;
  eventCount: number;
  audioBytes: number;
  closeNdjson: () => Promise<FileRecord[]>;
  closeAudio: () => Promise<FileRecord[]>;
  code: string;
  message: string;
  noFilesHints: Hint[];
}

async function streamFailure(
  ctx: ResponseContext,
  op: OperationCard,
  base: Omit<SuccessEnvelope, "v" | "ok">,
  warnings: Warning[],
  error: unknown,
  options: StreamFailureOptions,
): Promise<Envelope> {
  const files: FileRecord[] = [];
  if (options.eventCount > 0) {
    files.push(...(await options.closeNdjson()));
  } else {
    await options.ndjson.abort();
  }
  if (options.audio) {
    if (options.audioBytes > 0) {
      files.push(...(await options.closeAudio()));
    } else {
      await options.audio.abort();
    }
  }
  const parseError = error instanceof Error ? error.message : String(error);
  return failure({
    cmd: ctx.cmd,
    operation_id: op.operationId,
    http: base.http,
    error: {
      type: "provider_error",
      code: options.code,
      message: options.message,
      raw: { parse_error: parseError },
    },
    retry: { recommended: false, after_ms: null },
    cost: base.cost,
    files: files.length > 0 ? files : undefined,
    warnings: optional(warnings),
    hints:
      files.length > 0
        ? [
            {
              cmd: `elv view ${shellArg(files[0]!.path)}`,
              why: "Inspect preserved partial output; provider credits may already have been consumed.",
            },
          ]
        : options.noFilesHints,
  });
}

function feedSse(state: SseParserState, text: string, final: boolean): SseFrame[] {
  state.pending += text;
  const frames: SseFrame[] = [];

  while (true) {
    const newline = firstSseNewline(state.pending);
    if (newline === -1) break;
    if (state.pending[newline] === "\r" && newline === state.pending.length - 1 && !final) break;
    const line = state.pending.slice(0, newline);
    const width = state.pending[newline] === "\r" && state.pending[newline + 1] === "\n" ? 2 : 1;
    state.pending = state.pending.slice(newline + width);
    acceptSseLine(state, line, frames);
  }

  if (final) {
    if (state.pending.length > 0) acceptSseLine(state, state.pending, frames);
    state.pending = "";
    dispatchSseFrame(state, frames);
  }
  return frames;
}

function firstSseNewline(value: string): number {
  const cr = value.indexOf("\r");
  const lf = value.indexOf("\n");
  if (cr === -1) return lf;
  if (lf === -1) return cr;
  return Math.min(cr, lf);
}

function acceptSseLine(state: SseParserState, line: string, frames: SseFrame[]): void {
  if (line === "") dispatchSseFrame(state, frames);
  else state.lines.push(line);
}

function dispatchSseFrame(state: SseParserState, frames: SseFrame[]): void {
  if (state.lines.length === 0) return;
  const frame = parseSseFrame(state.lines);
  state.lines = [];
  if (frame) frames.push(frame);
}

function parseSseFrame(lines: string[]): SseFrame | undefined {
  const data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;

  for (const line of lines) {
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id" && !value.includes("\0")) id = value;
    else if (field === "retry" && /^\d+$/u.test(value)) retry = Number(value);
  }

  if (data.length === 0) return undefined;
  return { data: data.join("\n"), event, id, retry };
}

async function writeSseFrame(
  frame: SseFrame,
  ndjson: ReturnType<typeof tempFileWriter>,
  audioWriter: () => ReturnType<typeof tempFileWriter>,
  recordAudioBytes: (bytes: number) => void,
): Promise<{ event: boolean }> {
  if (frame.data.trim() === "[DONE]") return { event: false };
  const payload =
    frame.event === "audio_chunk" && !frame.data.trimStart().startsWith("{")
      ? frame.data
      : parseSseData(frame.data);
  const { data, audio } = extractSseAudio(payload, frame.event);
  if (audio) {
    await audioWriter().write(audio);
    recordAudioBytes(audio.byteLength);
  }
  await ndjson.write(
    `${JSON.stringify({
      ...(frame.event !== undefined ? { event: frame.event } : {}),
      ...(frame.id !== undefined ? { id: frame.id } : {}),
      ...(frame.retry !== undefined ? { retry: frame.retry } : {}),
      data,
    })}\n`,
  );
  return { event: true };
}

function parseSseData(data: string): unknown {
  try {
    return parseJsonValue(data);
  } catch {
    return data;
  }
}

function extractSseAudio(
  payload: unknown,
  event: string | undefined,
): { data: unknown; audio?: Buffer } {
  if (event === "audio_chunk" && typeof payload === "string") {
    return { data: null, audio: decodeBase64(payload, "stream event") };
  }
  if (!isRecord(payload)) return { data: payload };
  const output = { ...payload };
  let encoded: string | undefined;
  for (const key of ["audio_chunk", "audio_base64", "audio"] as const) {
    if (typeof output[key] !== "string") continue;
    encoded ??= output[key];
    delete output[key];
  }
  return encoded === undefined
    ? { data: output }
    : { data: output, audio: decodeBase64(encoded, "stream event") };
}

async function streamJsonEventsResponse(
  op: OperationCard,
  res: Response,
  ctx: ResponseContext,
  base: Omit<SuccessEnvelope, "v" | "ok">,
  warnings: Warning[],
): Promise<Envelope> {
  const target = resolveOutTarget(ctx.out, true);
  const ndjson = tempFileWriter(
    join(target.dir, deriveFilename(op.operationId, undefined, "ndjson")),
  );
  let audio: ReturnType<typeof tempFileWriter> | undefined;
  const decoder = new TextDecoder();
  let pending = "";
  let eventCount = 0;
  let audioBytes = 0;

  try {
    for await (const chunk of toNodeReadable(res.body ?? Readable.from([]))) {
      pending += decoder.decode(chunkBuffer(chunk), { stream: true });
      const parsed = extractJsonObjects(pending);
      pending = parsed.rest;
      for (const event of parsed.objects) {
        await writeJsonEvent(
          event,
          ndjson,
          () => (audio ??= jsonEventsAudioWriter(op, ctx, target.dir)),
          (bytes) => {
            audioBytes += bytes;
          },
        );
        eventCount += 1;
      }
    }

    pending += decoder.decode();
    const parsed = extractJsonObjects(pending);
    if (parsed.rest.trim()) throw new Error("Incomplete trailing JSON event");
    for (const event of parsed.objects) {
      await writeJsonEvent(
        event,
        ndjson,
        () => (audio ??= jsonEventsAudioWriter(op, ctx, target.dir)),
        (bytes) => {
          audioBytes += bytes;
        },
      );
      eventCount += 1;
    }

    const ndjsonPath = await ndjson.close();
    const files: FileRecord[] = [
      { ...(await fileRecord(ndjsonPath, { hash: ctx.hash })), mime: "application/x-ndjson" },
    ];
    if (audio) {
      const audioPath = await audio.close();
      files.push(await fileRecord(audioPath, { hash: ctx.hash }));
    }
    return fileSuccess(base, files, warnings);
  } catch (error) {
    return streamFailure(ctx, op, base, warnings, error, {
      ndjson,
      audio,
      eventCount,
      audioBytes,
      closeNdjson: async () => {
        const path = await ndjson.close();
        return [
          {
            ...(await fileRecord(path, { hash: ctx.hash })),
            mime: "application/x-ndjson",
            partial: true,
          },
        ];
      },
      closeAudio: async () => {
        const path = await audio!.close();
        return [{ ...(await fileRecord(path, { hash: ctx.hash })), partial: true }];
      },
      code: "invalid_json_events_stream",
      message: "Provider returned a malformed JSON events stream",
      noFilesHints: [
        {
          cmd: ctx.cmd,
          why: "Retry only if needed; provider credits may already have been consumed.",
        },
      ],
    });
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
  recordAudioBytes: (bytes: number) => void,
): Promise<void> {
  const encoded = isRecord(event)
    ? typeof event.audio_base64 === "string"
      ? event.audio_base64
      : event.audio
    : undefined;
  const audio =
    typeof encoded === "string" && encoded.length > 0
      ? decodeBase64(encoded, "stream event")
      : undefined;
  await ndjson.write(`${JSON.stringify(event)}\n`);
  if (audio) {
    await audioWriter().write(audio);
    recordAudioBytes(audio.byteLength);
  }
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
    if (char === "\\") {
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
      objects.push(parseJsonValue(text.slice(start, index + 1)));
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

function chunkBuffer(chunk: Buffer | Uint8Array | string): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (typeof chunk === "string") return Buffer.from(chunk);
  return Buffer.from(String(chunk));
}

function audioExtensionFromRequestPath(path: string | undefined): string {
  if (!path) return "mp3";
  const outputFormat = requestPathSearchParams(path).get("output_format") ?? "";
  const codec = outputFormat.split("_")[0];
  if (codec === "pcm" || codec === "ulaw" || codec === "alaw" || codec === "opus") return codec;
  return "mp3";
}

function requestPathSearchParams(path: string): URLSearchParams {
  const queryStart = path.indexOf("?");
  return new URLSearchParams(queryStart === -1 ? "" : path.slice(queryStart + 1));
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
      return parseOptionalJsonBody(text);
    } catch (error) {
      return {
        detail: text,
        parse_error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { detail: text };
}

function parseOptionalJsonBody(text: string): unknown {
  if (!text) return null;
  return parseJsonValue(text);
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

function previewText(value: string): string {
  return value.length > 500 ? `${value.slice(0, 500)}...` : value;
}

function optional<T>(items: T[]): T[] | undefined {
  return items.length > 0 ? items : undefined;
}
