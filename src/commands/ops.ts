import { failure, success } from "../core/envelope";
import { validationError } from "../core/errors";
import { ExitCode } from "../core/types";
import {
  buildExampleCommand,
  compactSchemaForOperation,
  rawInputSchemaForOperation,
} from "../openapi/compact-schema";
import { readRegistryCache, loadRegistry } from "../openapi/registry";
import type { CostHint, HttpMethod, OperationCard, Risk, StreamKind } from "../openapi/types";
import type { CommandResult, Hint, Warning } from "../core/types";

interface SearchResult {
  operation_id: string;
  method: OperationCard["method"];
  path: string;
  group: string[];
  summary?: string;
  risk: Risk;
  cost_hint: CostHint;
  deprecated: boolean;
}

interface OpsSearchOptions {
  limit?: string | number;
}

export interface OpsListOptions {
  group?: string;
  method?: string;
  risk?: string;
  stream?: string;
  cost?: string;
  deprecated?: boolean;
  uploads?: boolean;
  limit?: string | number;
}

interface NormalizedListOptions {
  group?: string;
  method?: HttpMethod;
  risk?: Risk;
  stream?: StreamKind;
  cost?: CostHint;
  deprecated: boolean;
  uploads: boolean;
  limit: number;
}

export interface OpsListItem {
  operation_id: string;
  method: HttpMethod;
  path: string;
  group: string[];
  summary?: string;
  risk: Risk;
  stream: StreamKind;
  cost_hint: CostHint;
  deprecated: boolean;
  upload_fields: string[];
}

interface OpsSchemaOptions {
  raw?: boolean;
  example?: boolean;
}

export async function handleOpsSearch(
  query: string,
  options: OpsSearchOptions = {},
): Promise<CommandResult> {
  const limit = parseLimit(options.limit);
  if (!query.trim()) {
    return {
      env: validationError("elv ops search", "Missing search query"),
      exitCode: ExitCode.InputValidation,
    };
  }
  if (limit === null) {
    return {
      env: validationError("elv ops search", "--limit must be a positive integer"),
      exitCode: ExitCode.InputValidation,
    };
  }
  const registry = await loadRegistry();
  return {
    env: success({
      cmd: `elv ops search ${query}`,
      data: searchOperations(registry, query, limit),
    }),
    exitCode: ExitCode.Success,
  };
}

export async function handleOpsList(options: OpsListOptions = {}): Promise<CommandResult> {
  const parsed = normalizeListOptions(options);
  if (typeof parsed === "string") {
    return {
      env: validationError("elv ops list", parsed),
      exitCode: ExitCode.InputValidation,
    };
  }
  const registry = await loadRegistry();
  const matches = listOperations(registry, parsed);
  return {
    env: success({
      cmd: "elv ops list",
      data: {
        items: matches.slice(0, parsed.limit),
        count: Math.min(matches.length, parsed.limit),
        total_matches: matches.length,
        limit: parsed.limit,
      },
    }),
    exitCode: ExitCode.Success,
  };
}

export async function handleOpsGet(operationId: string): Promise<CommandResult> {
  const registry = await loadRegistry();
  const op = registry.get(operationId);
  if (!op) return unknownOperation(`elv ops get ${operationId}`, operationId);
  return {
    env: success({
      cmd: `elv ops get ${operationId}`,
      operation_id: operationId,
      data: op,
      ...deprecationAnnotation(op),
    }),
    exitCode: ExitCode.Success,
  };
}

export async function handleOpsSchema(
  operationId: string,
  options: OpsSchemaOptions = {},
): Promise<CommandResult> {
  if (options.raw && options.example) {
    return {
      env: validationError(`elv ops schema ${operationId}`, "Use only one of --raw or --example"),
      exitCode: ExitCode.InputValidation,
    };
  }
  const registry = await loadRegistry();
  const cached = readRegistryCache();
  const op = registry.get(operationId);
  if (!op) return unknownOperation(`elv ops schema ${operationId}`, operationId);
  const spec = cached?.bundledSpec;
  if (!spec) {
    return {
      env: failure({
        cmd: `elv ops schema ${operationId}`,
        operation_id: operationId,
        error: {
          type: "runtime_error",
          code: "registry_cache_missing",
          message: "Registry cache did not include the bundled OpenAPI spec",
        },
        retry: { recommended: false, after_ms: null },
      }),
      exitCode: ExitCode.ProviderError,
    };
  }

  const data = options.example
    ? { example: buildExampleCommand(op, spec) }
    : options.raw
      ? rawInputSchemaForOperation(op, spec)
      : compactSchemaForOperation(op, spec);
  return {
    env: success({
      cmd: `elv ops schema ${operationId}`,
      operation_id: operationId,
      data,
      ...deprecationAnnotation(op),
    }),
    exitCode: ExitCode.Success,
  };
}

export function searchOperations(
  registry: Map<string, OperationCard>,
  query: string,
  limit = 10,
): SearchResult[] {
  const expanded = expandAliases(query);
  const queryTokens = tokenize(expanded);
  const normalizedQuery = normalizePhrase(expanded);
  const scored = [...registry.values()]
    .map((op) => ({ op, score: scoreOperation(op, queryTokens, normalizedQuery) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.op.operationId.localeCompare(b.op.operationId));

  return scored.slice(0, limit).map(({ op }) => ({
    operation_id: op.operationId,
    method: op.method,
    path: op.pathTemplate,
    group: op.group,
    summary: op.summary,
    risk: op.risk,
    cost_hint: op.costHint ?? "unknown",
    deprecated: op.deprecated,
  }));
}

export function listOperations(
  registry: Map<string, OperationCard>,
  options: NormalizedListOptions,
): OpsListItem[] {
  return [...registry.values()]
    .filter((op) => matchesListFilters(op, options))
    .sort((a, b) => a.operationId.localeCompare(b.operationId))
    .map((op) => ({
      operation_id: op.operationId,
      method: op.method,
      path: op.pathTemplate,
      group: op.group,
      summary: op.summary,
      risk: op.risk,
      stream: op.streamKind,
      cost_hint: op.costHint ?? "unknown",
      deprecated: op.deprecated,
      upload_fields: op.requestBody?.fileFields ?? [],
    }));
}

function scoreOperation(op: OperationCard, queryTokens: string[], normalizedQuery: string): number {
  const id = op.operationId.toLowerCase();
  const path = op.pathTemplate.toLowerCase();
  if (id === normalizedQuery || path === normalizedQuery) return 1_000_000;

  return (
    scoreField(op.operationId, queryTokens, normalizedQuery, 7) +
    scoreField(op.pathTemplate, queryTokens, normalizedQuery, 7) +
    scoreField(op.summary ?? "", queryTokens, normalizedQuery, 3) +
    scoreField(op.description ?? "", queryTokens, normalizedQuery, 1) +
    scoreField([...op.group, ...op.tags].join(" "), queryTokens, normalizedQuery, 2)
  );
}

function scoreField(
  field: string,
  queryTokens: string[],
  normalizedQuery: string,
  weight: number,
): number {
  if (!field) return 0;
  const fieldTokens = new Set(tokenize(field));
  const overlap = queryTokens.filter((token) => fieldTokens.has(token)).length;
  const phraseBonus = normalizePhrase(field).includes(normalizedQuery)
    ? queryTokens.length * weight
    : 0;
  return overlap * weight + phraseBonus;
}

// elv's own command abbreviations don't appear in the spelled-out operation
// vocabulary (ops are text_to_speech_*, not tts), so expand them before scoring.
const QUERY_ALIASES: Record<string, string> = {
  tts: "text to speech",
  stt: "speech to text",
  sfx: "sound effects",
  isolate: "audio isolation",
};

function expandAliases(query: string): string {
  return tokenize(query)
    .map((token) => QUERY_ALIASES[token] ?? token)
    .join(" ");
}

function tokenize(value: string): string[] {
  return normalizePhrase(value).split(" ").filter(Boolean);
}

function normalizePhrase(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function parseLimit(value: string | number | undefined): number | null {
  if (value === undefined) return 10;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;
const RISKS = ["read", "mutate", "generate", "external_side_effect", "destructive"] as const;
const STREAM_KINDS = ["none", "audio_bytes", "json_events", "sse_events", "text"] as const;
const COST_HINTS = [
  "characters",
  "audio_seconds",
  "per_generation",
  "per_source_minute",
  "slot",
  "unknown",
] as const;

function normalizeListOptions(options: OpsListOptions): NormalizedListOptions | string {
  const method = normalizeEnum(options.method?.toUpperCase(), HTTP_METHODS, "--method");
  if (typeof method === "string" && !HTTP_METHODS.includes(method as HttpMethod)) return method;
  const risk = normalizeEnum(options.risk?.toLowerCase(), RISKS, "--risk");
  if (typeof risk === "string" && !RISKS.includes(risk as Risk)) return risk;
  const stream = normalizeEnum(options.stream?.toLowerCase(), STREAM_KINDS, "--stream");
  if (typeof stream === "string" && !STREAM_KINDS.includes(stream as (typeof STREAM_KINDS)[number]))
    return stream;
  const cost = normalizeEnum(options.cost?.toLowerCase(), COST_HINTS, "--cost");
  if (typeof cost === "string" && !COST_HINTS.includes(cost as CostHint)) return cost;
  const limit = options.limit === undefined ? 100 : parseLimit(options.limit);
  if (limit === null || limit > 500) return "--limit must be an integer from 1 to 500";

  return {
    group: options.group?.trim().toLowerCase() || undefined,
    method: method as HttpMethod | undefined,
    risk: risk as Risk | undefined,
    stream: stream as StreamKind | undefined,
    cost: cost as CostHint | undefined,
    deprecated: options.deprecated ?? false,
    uploads: options.uploads ?? false,
    limit,
  };
}

function normalizeEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  flag: string,
): T | undefined | string {
  if (value === undefined) return undefined;
  if (allowed.includes(value as T)) return value as T;
  return `${flag} must be one of: ${allowed.join(", ")}`;
}

function matchesListFilters(op: OperationCard, options: NormalizedListOptions): boolean {
  if (options.group && !op.group.some((group) => group.toLowerCase() === options.group))
    return false;
  if (options.method && op.method !== options.method) return false;
  if (options.risk && op.risk !== options.risk) return false;
  if (options.stream && op.streamKind !== options.stream) return false;
  if (options.cost && (op.costHint ?? "unknown") !== options.cost) return false;
  if (options.deprecated && !op.deprecated) return false;
  if (options.uploads && (op.requestBody?.fileFields?.length ?? 0) === 0) return false;
  return true;
}

function deprecationAnnotation(op: OperationCard): { warnings?: Warning[]; hints?: Hint[] } {
  if (!op.deprecated) return {};
  const replacement = replacementFromDescription(op.description);
  return {
    warnings: [
      {
        code: "deprecated_operation",
        message: replacement
          ? `${op.operationId} is deprecated; use ${replacement} instead.`
          : `${op.operationId} is deprecated.`,
      },
    ],
    hints: replacement ? [replacementHint(replacement)] : undefined,
  };
}

function replacementFromDescription(description: string | undefined): string | undefined {
  if (!description) return undefined;
  const plain = description.replace(/[`*_]/gu, "");
  return plain.match(
    /\buse\s+((?:(?:GET|POST|PUT|PATCH|DELETE|HEAD)\s+)?\/[^\s,;.)]+|[a-z][a-z0-9_-]+)\s+instead\b/iu,
  )?.[1];
}

function replacementHint(replacement: string): Hint {
  const request = replacement.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD)\s+(\/\S+)$/iu);
  if (request) {
    return {
      cmd: `elv http ${request[1]?.toUpperCase()} ${request[2]}`,
      why: "Use the replacement endpoint.",
    };
  }
  return {
    cmd: `elv ops search ${JSON.stringify(replacement)}`,
    why: "Find the replacement operation and its input schema.",
  };
}

function unknownOperation(cmd: string, operationId: string): CommandResult {
  return {
    env: failure({
      cmd,
      operation_id: operationId,
      error: {
        type: "not_found_error",
        code: "unknown_operation",
        message: `Unknown operation: ${operationId}`,
      },
      retry: { recommended: false, after_ms: null },
      hints: [{ cmd: "elv ops search <query>", why: "Find a valid operation_id." }],
    }),
    exitCode: ExitCode.NotFound,
  };
}
