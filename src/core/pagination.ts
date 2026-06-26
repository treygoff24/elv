import { join } from "node:path";
import { deriveFilename, fileRecord, resolveOutTarget, writeBufferToFile } from "./files";
import { success } from "./envelope";
import { shellArg } from "../util/shell";
import type { HttpMethod, OperationCard } from "../openapi/types";
import type { AgentInput, Envelope, FileRecord, SuccessEnvelope, Warning } from "./types";

export interface PaginationOptions {
  all?: boolean;
  limit?: number;
  saveJson?: string;
  out?: string;
  hash?: boolean;
}

export interface PaginationCommand {
  kind: "call" | "http";
  method?: HttpMethod;
  path?: string;
}

export interface CursorInfo {
  hasMore: boolean;
  cursorParam?: string;
  cursor?: string;
  warnings: Warning[];
}

export interface CollectAllPagesOptions {
  op: OperationCard;
  input: AgentInput;
  out?: string;
  saveJson?: string;
  hash?: boolean;
  command: PaginationCommand;
  fetchPage: (input: AgentInput) => Promise<Envelope>;
  maxPages?: number;
  limit?: number;
}

type Family = "history" | "voices_v2" | "voices_v1" | "convai" | "fallback";

const DEFAULT_LIMIT = 20;
const MAX_PAGES = 1000;

export function applyPaginationDefaults(
  op: OperationCard,
  input: AgentInput,
  limit = DEFAULT_LIMIT,
): AgentInput {
  const param = pageSizeParam(op);
  if (!param) return input;
  const query = { ...input.query };
  if (query[param] === undefined) query[param] = Math.max(1, Math.trunc(limit));
  return { ...input, query };
}

export function addPaginationToEnvelope(
  env: Envelope,
  op: OperationCard,
  input: AgentInput,
  options: { command: PaginationCommand; limit?: number },
): Envelope {
  if (!env.ok || env.data === undefined) return env;
  const data = asRecord(env.data);
  if (!data) return env;

  const warnings: Warning[] = [...(env.warnings ?? [])];
  const cursor = nextCursor(op, data);
  warnings.push(...cursor.warnings);
  const next = cursor.cursor
    ? { cmd: nextCommand(op, inputWithCursor(input, cursor), options.command) }
    : undefined;
  const limited = limitData(op, data, options.limit ?? DEFAULT_LIMIT);
  const nextData = next ? { ...limited.data, next } : limited.data;

  return {
    ...env,
    data: nextData,
    truncated: Boolean(env.truncated || limited.truncated),
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

export function nextCursor(op: OperationCard, data: unknown): CursorInfo {
  const record = asRecord(data);
  if (!record) return { hasMore: false, warnings: [] };

  const hasMore = record.has_more === true;
  if (!hasMore) return { hasMore: false, warnings: [] };

  const family = resourceFamily(op);
  if (family === "history")
    return cursorFromField(record, "last_history_item_id", "start_after_history_item_id");
  if (family === "voices_v2") return cursorFromField(record, "next_page_token", "next_page_token");
  if (family === "convai") return cursorFromField(record, "next_cursor", "cursor");

  const fallback = fallbackCursor(record);
  if (fallback) return { hasMore: true, ...fallback, warnings: [] };
  return {
    hasMore: true,
    warnings: [
      {
        code: "pagination_cursor_missing",
        message: "Response has has_more=true but no derivable cursor; no next command emitted.",
      },
    ],
  };
}

export async function collectAllPages(options: CollectAllPagesOptions): Promise<Envelope> {
  const cap = options.maxPages ?? MAX_PAGES;
  let input = applyPaginationDefaults(options.op, options.input, options.limit ?? DEFAULT_LIMIT);
  let lastEnv: SuccessEnvelope | undefined;
  const warnings: Warning[] = [];
  const items: unknown[] = [];

  for (let page = 0; page < cap; page += 1) {
    const env = await options.fetchPage(input);
    if (!env.ok) return env;
    lastEnv = env;
    items.push(...itemsFromData(options.op, env.data));

    const cursor = nextCursor(options.op, env.data);
    warnings.push(...cursor.warnings);
    if (!cursor.hasMore || !cursor.cursor) {
      return allPagesEnvelope(options, env, items, warnings);
    }

    const nextInput = inputWithCursor(input, cursor);
    if (JSON.stringify(nextInput.query ?? {}) === JSON.stringify(input.query ?? {})) {
      warnings.push({
        code: "pagination_cursor_repeated",
        message: "Stopping pagination because the next cursor did not change the request.",
      });
      return allPagesEnvelope(options, env, items, warnings);
    }
    input = nextInput;
  }

  warnings.push({
    code: "pagination_page_cap_hit",
    message: `Stopped after ${cap} pages to avoid an unbounded pagination loop.`,
  });
  return allPagesEnvelope(options, lastEnv, items, warnings);
}

export function allOutputTarget(options: PaginationOptions): string | undefined {
  return options.saveJson ?? options.out;
}

function cursorFromField(
  record: Record<string, unknown>,
  field: string,
  cursorParam: string,
): CursorInfo {
  const value = record[field];
  if (value === undefined || value === null || value === "") {
    return {
      hasMore: true,
      warnings: [
        {
          code: "pagination_cursor_missing",
          message: `Response has has_more=true but ${field} is absent; no next command emitted.`,
        },
      ],
    };
  }
  return { hasMore: true, cursorParam, cursor: String(value), warnings: [] };
}

function fallbackCursor(
  record: Record<string, unknown>,
): { cursorParam: string; cursor: string } | undefined {
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null || value === "") continue;
    if (key.startsWith("next_")) {
      if (key === "next_cursor") return { cursorParam: "cursor", cursor: String(value) };
      return { cursorParam: key, cursor: String(value) };
    }
    if (key === "cursor") return { cursorParam: "cursor", cursor: String(value) };
    if (key.startsWith("last_") && key.endsWith("_id")) {
      return { cursorParam: `start_after_${key.slice("last_".length)}`, cursor: String(value) };
    }
  }
  return undefined;
}

function inputWithCursor(input: AgentInput, cursor: CursorInfo): AgentInput {
  if (!cursor.cursorParam || cursor.cursor === undefined) return input;
  return { ...input, query: { ...input.query, [cursor.cursorParam]: cursor.cursor } };
}

function nextCommand(op: OperationCard, input: AgentInput, command: PaginationCommand): string {
  if (command.kind === "http") {
    const method = command.method ?? op.method;
    const path = command.path ?? op.pathTemplate;
    const query = Object.entries(input.query ?? {})
      .map(([key, value]) => ` --query ${shellArg(`${key}=${String(value)}`)}`)
      .join("");
    return `elv http ${method} ${shellArg(path)}${query}`;
  }
  return `elv call ${op.operationId} --json ${shellArg(JSON.stringify(input))}`;
}

function limitData(
  op: OperationCard,
  data: Record<string, unknown>,
  limit: number,
): { data: Record<string, unknown>; truncated: boolean } {
  const key = itemKey(op, data);
  const items = key ? data[key] : undefined;
  if (!key || !Array.isArray(items) || items.length <= limit) return { data, truncated: false };
  return {
    data: {
      ...data,
      [key]: items.slice(0, limit),
      count_returned: Math.min(items.length, limit),
      truncated: true,
    },
    truncated: true,
  };
}

async function allPagesEnvelope(
  options: CollectAllPagesOptions,
  env: SuccessEnvelope | undefined,
  items: unknown[],
  warnings: Warning[],
): Promise<Envelope> {
  const file = await writeAllItems(options, items);
  const base = env ?? success({ cmd: nextCommand(options.op, options.input, options.command) });
  return success({
    cmd: base.cmd,
    operation_id: base.operation_id,
    http: base.http,
    request: base.request,
    concurrency: base.concurrency,
    cost: base.cost,
    data_summary: { type: "array", count: items.length },
    files: [file],
    truncated: true,
    warnings: warnings.length > 0 ? warnings : undefined,
    hints: [],
  });
}

async function writeAllItems(
  options: CollectAllPagesOptions,
  items: unknown[],
): Promise<FileRecord> {
  const target = resolveOutTarget(options.saveJson ?? options.out, false);
  const filename = target.file ?? deriveFilename(options.op.operationId, "all", "json");
  const path = await writeBufferToFile(
    `${JSON.stringify(items, null, 2)}\n`,
    join(target.dir, filename),
  );
  return { ...(await fileRecord(path, { hash: options.hash })), mime: "application/json" };
}

function itemsFromData(op: OperationCard, data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const record = asRecord(data);
  if (!record) return [];
  const key = itemKey(op, record);
  const items = key === undefined ? undefined : record[key];
  if (Array.isArray(items)) return items;
  return [data];
}

function itemKey(op: OperationCard, data: Record<string, unknown>): string | undefined {
  const family = resourceFamily(op);
  if (family === "history" && Array.isArray(data.history)) return "history";
  if ((family === "voices_v1" || family === "voices_v2") && Array.isArray(data.voices))
    return "voices";
  if (family === "convai") {
    for (const key of ["agents", "conversations", "items"])
      if (Array.isArray(data[key])) return key;
  }
  return Object.keys(data).find((key) => Array.isArray(data[key]));
}

function pageSizeParam(op: OperationCard): string | undefined {
  if (op.queryParams.some((param) => param.name === "page_size")) return "page_size";
  const family = resourceFamily(op);
  if (family === "history" || family === "voices_v2") return "page_size";
  if (op.operationId === "get_agents_route" || op.pathTemplate === "/v1/convai/agents")
    return "page_size";
  return undefined;
}

export function supportsPagination(op: OperationCard): boolean {
  return pageSizeParam(op) !== undefined;
}

function resourceFamily(op: OperationCard): Family {
  const id = op.operationId;
  const path = op.pathTemplate;
  if (id === "get_voices" || path === "/v1/voices") return "voices_v1";
  if (id === "get_user_voices_v2" || path === "/v2/voices") return "voices_v2";
  if (id === "get_speech_history" || path === "/v1/history") return "history";
  if (id === "get_agents_route" || path === "/v1/convai/agents") return "convai";
  if (path.startsWith("/v1/convai/")) return "convai";
  return "fallback";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
