import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { emitAndExit, exitCodeForError, validationError } from "../core/errors";
import { runOperation } from "../core/client";
import { ExitCode } from "../core/types";
import type { AgentInput, RunOpts } from "../core/types";
import type { PaginationOptions } from "../core/pagination";

export interface CallOptions {
  json?: string;
  jsonFile?: string;
  stdinJson?: boolean;
  query?: string[];
  path?: string[];
  file?: string[];
  out?: string;
  maxCredits?: string | number;
  dryRun?: boolean;
  yes?: boolean;
  retryPost?: boolean;
  allowUnknown?: boolean;
  unpack?: boolean;
  hash?: boolean;
  baseUrl?: string;
  profile?: string;
  all?: boolean;
  limit?: string | number;
  saveJson?: string;
}

export async function handleCall(operationId: string, options: CallOptions): Promise<never> {
  const parsed = parseCallInput(operationId, options);
  if (!parsed.ok) emitAndExit(parsed.env, ExitCode.InputValidation);

  const env = await runOperation(operationId, parsed.input, runOpts(options));
  emitAndExit(
    env,
    env.ok ? ExitCode.Success : exitCodeForError(env.error, env.http?.status ?? undefined),
  );
}

export function parseCallInput(
  operationId: string,
  options: CallOptions,
):
  | { ok: true; input: AgentInput | Record<string, unknown> }
  | { ok: false; env: ReturnType<typeof validationError> } {
  const cmd = `elv call ${operationId}`;
  const jsonSources = [
    options.json,
    options.jsonFile,
    options.stdinJson ? "stdin" : undefined,
  ].filter(Boolean);
  if (jsonSources.length > 1) {
    return {
      ok: false,
      env: validationError(cmd, "Use only one of --json, --json-file, or --stdin-json"),
    };
  }

  let input: Record<string, unknown> = {};
  try {
    if (options.json !== undefined) input = parseJsonObject(options.json);
    else if (options.jsonFile !== undefined)
      input = parseJsonObject(readFileSync(options.jsonFile, "utf8"));
    else if (options.stdinJson) input = parseJsonObject(readFileSync(0, "utf8"));
  } catch (error) {
    return {
      ok: false,
      env: validationError(cmd, error instanceof Error ? error.message : String(error)),
    };
  }

  try {
    addPairs(input, "query", options.query);
    addPairs(input, "path", options.path);
    addFiles(input, options.file);
  } catch (error) {
    return {
      ok: false,
      env: validationError(cmd, error instanceof Error ? error.message : String(error)),
    };
  }
  return { ok: true, input };
}

function runOpts(options: CallOptions): RunOpts & PaginationOptions {
  const maxCredits =
    options.maxCredits === undefined || options.maxCredits === ""
      ? undefined
      : Number(options.maxCredits);
  const limit =
    options.limit === undefined || options.limit === "" ? undefined : Number(options.limit);
  return {
    dryRun: options.dryRun,
    yes: options.yes,
    retryPost: options.retryPost,
    allowUnknown: options.allowUnknown,
    unpack: options.unpack,
    hash: options.hash,
    out: options.out,
    baseUrl: options.baseUrl,
    profile: options.profile,
    maxCredits: Number.isFinite(maxCredits) ? maxCredits : undefined,
    all: options.all,
    saveJson: options.saveJson,
    // Pass the raw parsed number through; runOperation validates it (positive integer)
    // so call/http/aliases reject invalid --limit identically instead of silently coercing.
    limit,
  };
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON input must be an object");
  }
  return parsed as Record<string, unknown>;
}

function addPairs(
  input: Record<string, unknown>,
  bucket: "query" | "path",
  pairs: string[] | undefined,
): void {
  if (!pairs || pairs.length === 0) return;
  const current = bucketObject(input, bucket);
  for (const pair of pairs) {
    const { key, value } = parsePair(pair);
    current[key] = value;
  }
}

function addFiles(input: Record<string, unknown>, files: string[] | undefined): void {
  if (!files || files.length === 0) return;
  const current = bucketObject(input, "files") as Record<string, string | string[]>;
  for (const file of files) {
    const { key, value } = parsePair(file);
    const field = key.endsWith("[]") ? key.slice(0, -2) : key;
    const path = resolve(value);
    if (key.endsWith("[]")) {
      const previous = current[field];
      current[field] = Array.isArray(previous)
        ? [...previous, path]
        : previous
          ? [previous, path]
          : [path];
    } else {
      current[field] = path;
    }
  }
}

function parsePair(pair: string): { key: string; value: string } {
  const index = pair.indexOf("=");
  if (index <= 0) throw new Error(`Expected key=value, got "${pair}"`);
  return { key: pair.slice(0, index), value: pair.slice(index + 1) };
}

function bucketObject(
  input: Record<string, unknown>,
  bucket: "query" | "path" | "files",
): Record<string, unknown> {
  const existing = input[bucket];
  if (existing === undefined) {
    const next: Record<string, unknown> = {};
    input[bucket] = next;
    return next;
  }
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    throw new Error(`${bucket} must be an object`);
  }
  return existing as Record<string, unknown>;
}
