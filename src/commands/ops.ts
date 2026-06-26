import { failure, success } from "../core/envelope";
import { validationError } from "../core/errors";
import { ExitCode } from "../core/types";
import {
  buildExampleCommand,
  compactSchemaForOperation,
  rawInputSchemaForOperation,
} from "../openapi/compact-schema";
import { readRegistryCache, loadRegistry } from "../openapi/registry";
import type { OperationCard, Risk } from "../openapi/types";
import type { Envelope } from "../core/types";

interface SearchResult {
  operation_id: string;
  method: OperationCard["method"];
  path: string;
  group: string[];
  summary?: string;
  risk: Risk;
}

interface OpsSearchOptions {
  limit?: string | number;
}

interface OpsSchemaOptions {
  raw?: boolean;
  example?: boolean;
}

type OpsResult = { env: Envelope; exitCode: ExitCode };

export async function handleOpsSearch(
  query: string,
  options: OpsSearchOptions = {},
): Promise<OpsResult> {
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

export async function handleOpsGet(operationId: string): Promise<OpsResult> {
  const registry = await loadRegistry();
  const op = registry.get(operationId);
  if (!op) return unknownOperation(`elv ops get ${operationId}`, operationId);
  return {
    env: success({ cmd: `elv ops get ${operationId}`, operation_id: operationId, data: op }),
    exitCode: ExitCode.Success,
  };
}

export async function handleOpsSchema(
  operationId: string,
  options: OpsSchemaOptions = {},
): Promise<OpsResult> {
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
    env: success({ cmd: `elv ops schema ${operationId}`, operation_id: operationId, data }),
    exitCode: ExitCode.Success,
  };
}

export function searchOperations(
  registry: Map<string, OperationCard>,
  query: string,
  limit = 10,
): SearchResult[] {
  const queryTokens = tokenize(query);
  const normalizedQuery = normalizePhrase(query);
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

function unknownOperation(cmd: string, operationId: string): OpsResult {
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
