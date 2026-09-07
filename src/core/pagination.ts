import { join } from "node:path";
import { deriveFilename, fileRecord, resolveOutTarget, tempFileWriter } from "./files";
import type { TempFileWriter } from "./files";
import { success } from "./envelope";
import { isRecord } from "../util/json";
import { shellArg } from "../util/shell";
import type { HttpMethod, OperationCard } from "../openapi/types";
import type { JsonObject, JsonValue } from "../util/json";
import type { AgentInput, Envelope, FileRecord, RunOpts, SuccessEnvelope, Warning } from "./types";

export interface PaginationOptions extends Pick<RunOpts, "out" | "hash"> {
  all?: boolean;
  limit?: number;
  saveJson?: string;
}

export type PaginatedRunOptions = RunOpts & PaginationOptions;

export interface PaginationCommand {
  kind: "call" | "http";
  method?: HttpMethod;
  path?: string;
}

interface CursorInfo {
  hasMore: boolean;
  cursorParam?: string;
  cursor?: string;
  warnings: Warning[];
}

interface CollectAllPagesOptions extends Pick<
  PaginationOptions,
  "out" | "saveJson" | "hash" | "limit"
> {
  op: OperationCard;
  input: AgentInput;
  command: PaginationCommand;
  fetchPage: (input: AgentInput) => Promise<Envelope>;
  maxPages?: number;
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
  if (query[param] === undefined) {
    const schema = op.queryParams.find((candidate) => candidate.name === param)?.schema;
    query[param] = Math.min(Math.max(1, Math.trunc(limit)), pageSizeMaximum(schema));
  }
  return { ...input, query };
}

/**
 * `--limit` doubles as the requested page size, so a limit above the provider's
 * documented maximum is silently clamped. Report the clamp rather than letting the
 * caller believe a larger page was requested. Pass the input as it was before
 * `applyPaginationDefaults`: a page size the caller supplied is never clamped.
 */
export function pageSizeClampWarning(
  op: OperationCard,
  rawInput: AgentInput,
  limit: number | undefined,
): Warning | undefined {
  const param = pageSizeParam(op);
  if (!param || limit === undefined || rawInput.query?.[param] !== undefined) return undefined;
  const requested = Math.max(1, Math.trunc(limit));
  const schema = op.queryParams.find((candidate) => candidate.name === param)?.schema;
  const maximum = pageSizeMaximum(schema);
  if (requested <= maximum) return undefined;
  return {
    code: "page_size_clamped",
    message: `${param} was clamped from ${requested} to the provider maximum of ${maximum}; --limit still bounds the items inlined in the envelope.`,
  };
}

function pageSizeMaximum(schema: JsonValue | undefined): number {
  if (!isRecord(schema)) return Infinity;
  if (typeof schema.maximum === "number" && schema.maximum >= 1) return Math.floor(schema.maximum);
  // The published nullable page-size schemas use anyOf(integer, null).
  if (Array.isArray(schema.anyOf)) {
    const numeric = schema.anyOf.find((branch) => isRecord(branch) && branch.type === "integer");
    return pageSizeMaximum(numeric);
  }
  return Infinity;
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

  if (record.has_more === false) return { hasMore: false, warnings: [] };

  const family = resourceFamily(op);
  const cursor =
    family === "history"
      ? cursorFromField(record, "last_history_item_id", "start_after_history_item_id")
      : family === "voices_v2"
        ? cursorFromField(record, "next_page_token", "next_page_token")
        : family === "convai"
          ? cursorFromField(record, "next_cursor", "cursor")
          : fallbackCursor(record);
  if (
    cursor?.cursor &&
    (record.has_more === true || op.queryParams.some((param) => param.name === cursor.cursorParam))
  ) {
    return { hasMore: true, ...cursor, warnings: [] };
  }
  if (record.has_more !== true) return { hasMore: false, warnings: [] };
  if (cursor && "warnings" in cursor) return cursor;

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

/**
 * Fetches every page, appending each page's items straight to the combined output file
 * instead of accumulating them in memory. Only the running count, the cursor, warnings,
 * and the per-page file records are retained, so a large inventory costs one page of
 * items rather than all of them.
 *
 * The output file is still published atomically at the end: it is written to a unique
 * temporary path and only claimed once every page has been collected, so an aborted or
 * failed run never publishes a partial collection as a complete one.
 */
export async function collectAllPages(options: CollectAllPagesOptions): Promise<Envelope> {
  const cap = options.maxPages ?? MAX_PAGES;
  let input = applyPaginationDefaults(options.op, options.input, options.limit ?? DEFAULT_LIMIT);
  let base: AllPagesBase | undefined;
  const warnings: Warning[] = [];
  const collected = new CollectedItemsFile(options);
  const files: FileRecord[] = [];

  try {
    for (let page = 0; page < cap; page += 1) {
      const env = await options.fetchPage(input);
      if (!env.ok) {
        await collected.abort();
        return files.length ? { ...env, files: [...files, ...(env.files ?? [])] } : env;
      }
      base = envelopeBase(env);
      files.push(...(env.files ?? []));
      for (const item of itemsFromData(options.op, env.data)) await collected.append(item);

      const cursor = nextCursor(options.op, env.data);
      warnings.push(...cursor.warnings);
      if (!cursor.hasMore || !cursor.cursor) {
        return await allPagesEnvelope(options, base, collected, warnings, files);
      }

      const nextInput = inputWithCursor(input, cursor);
      if (JSON.stringify(nextInput.query ?? {}) === JSON.stringify(input.query ?? {})) {
        warnings.push({
          code: "pagination_cursor_repeated",
          message: "Stopping pagination because the next cursor did not change the request.",
        });
        return await allPagesEnvelope(options, base, collected, warnings, files);
      }
      input = nextInput;
    }

    warnings.push({
      code: "pagination_page_cap_hit",
      message: `Stopped after ${cap} pages to avoid an unbounded pagination loop.`,
    });
    return await allPagesEnvelope(options, base, collected, warnings, files);
  } catch (error) {
    await collected.abort();
    throw error;
  }
}

export function allOutputTarget(options: PaginationOptions): string | undefined {
  return options.saveJson ?? options.out;
}

function cursorFromField(record: JsonObject, field: string, cursorParam: string): CursorInfo {
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

function fallbackCursor(record: JsonObject): { cursorParam: string; cursor: string } | undefined {
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
    const body =
      input.body === undefined ? "" : ` --body-json ${shellArg(JSON.stringify(input.body))}`;
    return `elv http ${method} ${shellArg(path)}${query}${body}`;
  }
  return `elv call ${op.operationId} --json ${shellArg(JSON.stringify(input))}`;
}

function limitData(
  op: OperationCard,
  data: JsonObject,
  limit: number,
): { data: JsonObject; truncated: boolean } {
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

/** The envelope fields `--all` carries over from the last page it actually fetched. */
type AllPagesBase = Pick<
  SuccessEnvelope,
  "cmd" | "operation_id" | "http" | "request" | "concurrency" | "cost"
>;

function envelopeBase(env: SuccessEnvelope): AllPagesBase {
  return {
    cmd: env.cmd,
    operation_id: env.operation_id,
    http: env.http,
    request: env.request,
    concurrency: env.concurrency,
    cost: env.cost,
  };
}

async function allPagesEnvelope(
  options: CollectAllPagesOptions,
  base: AllPagesBase | undefined,
  collected: CollectedItemsFile,
  warnings: Warning[],
  files: FileRecord[],
): Promise<Envelope> {
  const file = await collected.publish();
  const envelope =
    base ?? envelopeBase(success({ cmd: nextCommand(options.op, options.input, options.command) }));
  return success({
    ...envelope,
    data_summary: { type: "array", count: collected.count },
    files: [file, ...files],
    truncated: true,
    warnings: warnings.length > 0 ? warnings : undefined,
    hints: [],
  });
}

/**
 * Writes the combined `--all` collection incrementally, byte-for-byte identical to
 * `JSON.stringify(items, null, 2)` followed by a newline, so existing consumers of the
 * artifact — including `elv view` — see exactly the file they saw before.
 *
 * The underlying temporary file is created on the first write, which keeps a run whose
 * very first page fails from leaving any output behind, and it is published through the
 * same never-overwrite path `writeBufferToFile` used.
 */
class CollectedItemsFile {
  private writer: TempFileWriter | undefined;
  private items = 0;
  private settled = false;
  private readonly path: string;

  constructor(private readonly options: CollectAllPagesOptions) {
    const target = resolveOutTarget(options.saveJson ?? options.out, false);
    const filename = target.file ?? deriveFilename(options.op.operationId, "all", "json");
    this.path = join(target.dir, filename);
  }

  get count(): number {
    return this.items;
  }

  async append(item: JsonValue): Promise<void> {
    const writer = this.open();
    const body = indentJsonItem(item);
    await writer.write(this.items === 0 ? `[\n${body}` : `,\n${body}`);
    this.items += 1;
  }

  async publish(): Promise<FileRecord> {
    const writer = this.open();
    this.settled = true;
    let path: string;
    try {
      await writer.write(this.items === 0 ? "[]\n" : "\n]\n");
      path = await writer.close();
    } catch (error) {
      await writer.abort();
      throw error;
    }
    return { ...(await fileRecord(path, { hash: this.options.hash })), mime: "application/json" };
  }

  /** Discards the partial collection: nothing is published under the requested name. */
  async abort(): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    await this.writer?.abort();
  }

  private open(): TempFileWriter {
    if (this.settled) throw new Error("Combined pagination output is already finalized");
    return (this.writer ??= tempFileWriter(this.path));
  }
}

/** One array element as `JSON.stringify(items, null, 2)` would nest it. */
function indentJsonItem(item: JsonValue): string {
  const text = JSON.stringify(item, null, 2) ?? "null";
  return `  ${text.split("\n").join("\n  ")}`;
}

function itemsFromData(op: OperationCard, data: unknown): JsonValue[] {
  if (Array.isArray(data)) return data as JsonValue[];
  const record = asRecord(data);
  if (!record) return [];
  if (op.operationId === "get_knowledge_base_bulk_dependent_agents_route") {
    return ["agents", "branches"].flatMap((key) =>
      Array.isArray(record[key]) ? (record[key] as JsonValue[]) : [],
    );
  }
  const key = itemKey(op, record);
  const items = key === undefined ? undefined : record[key];
  if (Array.isArray(items)) return items;
  return [record];
}

function itemKey(op: OperationCard, data: JsonObject): string | undefined {
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

function asRecord(value: unknown): JsonObject | undefined {
  return isRecord(value) ? (value as JsonObject) : undefined;
}
