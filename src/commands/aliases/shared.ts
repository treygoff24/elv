import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { runOperation } from "../../core/client";
import { emitAndExit, exitCodeForError, validationError } from "../../core/errors";
import { ExitCode } from "../../core/types";
import { waitForOperation } from "../../core/wait-operation";
import { isRecord, parseJsonRecord } from "../../util/json";
import type { WaitOptions } from "../../core/wait-operation";
import {
  mergedOptions,
  optionString,
  paginationOptionsFromCommand,
  runOptsFromCommand,
} from "../options";
import type { AgentInput, Envelope, RunOpts, SuccessEnvelope } from "../../core/types";

export interface BuiltOperation {
  operationId: string;
  input: AgentInput;
}

export interface JsonBodyFlags {
  json?: string;
  jsonFile?: string;
}

type RequiredWaitFields = Required<Pick<WaitOptions, "operation" | "statusPath" | "success">>;

type OperationBuilder<T> = (flags: T) => BuiltOperation;

interface WaitAfterCreateConfig extends RequiredWaitFields, Pick<WaitOptions, "failure"> {
  commandName: string;
  idKeys: string[];
  missingIdMessage: string;
  pathKey: string;
}

export function aliasRunOpts(command: Command): RunOpts {
  return runOptsFromCommand(command);
}

function paginationOpts(command: Command): {
  all?: boolean;
  limit?: number;
  saveJson?: string;
} {
  return paginationOptionsFromCommand(command);
}

export function addPaginationFlags(command: Command): Command {
  return command
    .option("--limit <n>", "max items returned (also sets page size)")
    .option(
      "--all",
      "fetch every page and save the full set to a file (requires --save-json or --out)",
    )
    .option("--save-json <path>", "write the full JSON result to this path")
    .option(
      "--fields <csv>",
      "project list items to a comma-separated set of fields (compact inline output)",
    );
}

function fieldsOpt(command: Command): string[] | undefined {
  const raw = optionString(mergedOptions(command).fields);
  if (!raw) return undefined;
  const fields = raw
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);
  return fields.length ? fields : undefined;
}

// Resolve the fetch options for a list command. --fields returns a projected
// inline result, so it is mutually exclusive with the bulk-to-disk flags
// (--all / --save-json) — combining them would silently ignore the persistence
// request. Throwing here surfaces as a validation_error (exit 2) via runBuilt.
function resolveListOpts(command: Command): {
  fields?: string[];
  fetch: { all?: boolean; limit?: number; saveJson?: string; inline?: boolean };
} {
  const fields = fieldsOpt(command);
  const pagination = paginationOpts(command);
  if (fields && (pagination.all || pagination.saveJson !== undefined)) {
    throw new Error(
      "--fields cannot be combined with --all or --save-json; --fields returns a projected inline result (redirect stdout to save it)",
    );
  }
  return { fields, fetch: fields ? { inline: true, limit: pagination.limit } : pagination };
}

// Keep just the requested fields on the dominant collection of a list response,
// turning a fat result (every voice's full object) into a compact id/name table.
export function projectFields(env: SuccessEnvelope, fields: string[]): SuccessEnvelope {
  return { ...env, data: projectData(env.data, fields) };
}

function projectData(data: unknown, fields: string[]): unknown {
  if (Array.isArray(data)) return data.map((item) => pickFields(item, fields));
  if (isRecord(data)) {
    const key = longestArrayKey(data);
    if (key === undefined) return data;
    const value = data[key];
    return Array.isArray(value)
      ? { ...data, [key]: value.map((item) => pickFields(item, fields)) }
      : data;
  }
  return data;
}

// Pick the collection to project. Prefer the longest array whose elements are
// objects (the only kind a field projection applies to); fall back to the
// longest array of any kind so an empty collection still resolves.
function longestArrayKey(data: Record<string, unknown>): string | undefined {
  const longestOf = (predicate: (value: unknown[]) => boolean): string | undefined => {
    let bestKey: string | undefined;
    let bestLength = -1;
    for (const [key, value] of Object.entries(data)) {
      if (Array.isArray(value) && predicate(value) && value.length > bestLength) {
        bestKey = key;
        bestLength = value.length;
      }
    }
    return bestKey;
  };
  return longestOf((value) => value.some(isRecord)) ?? longestOf(() => true);
}

function pickFields(item: unknown, fields: string[]): unknown {
  if (!isRecord(item)) return item;
  const out: Record<string, unknown> = {};
  for (const field of fields) if (field in item) out[field] = item[field];
  return out;
}

export function commandName(command: Command): string {
  const names: string[] = [];
  for (let current: Command | null | undefined = command; current; current = current.parent) {
    if (current.name()) names.push(current.name());
  }
  return names.reverse().join(" ");
}

export function emit(env: Envelope): never {
  emitAndExit(
    env,
    env.ok ? ExitCode.Success : exitCodeForError(env.error, env.http?.status ?? undefined),
  );
}

export async function runAlias<T>(
  builder: OperationBuilder<T>,
  flags: T,
  command: Command,
): Promise<never> {
  const { built, opts } = validationOrExit(command, () => ({
    built: builder(flags),
    opts: aliasRunOpts(command),
  }));
  const env = await runOperation(built.operationId, built.input, opts);
  emit(env);
}

export async function runListAlias<T>(
  builder: OperationBuilder<T>,
  flags: T,
  command: Command,
  options: { mergeOptions?: boolean } = {},
): Promise<never> {
  const inputFlags = options.mergeOptions
    ? ({ ...(mergedOptions(command) as T), ...flags } as T)
    : flags;
  const { built, fields, fetch, opts } = validationOrExit(command, () => ({
    built: builder(inputFlags),
    opts: aliasRunOpts(command),
    ...resolveListOpts(command),
  }));
  const env = await runOperation(built.operationId, built.input, {
    ...opts,
    ...fetch,
  });
  emit(fields && env.ok ? projectFields(env, fields) : env);
}

function validationEnv(command: Command, error: unknown): ReturnType<typeof validationError> {
  return validationError(commandName(command), message(error));
}

function validationExit(command: Command, error: unknown): never {
  emitAndExit(validationEnv(command, error), ExitCode.InputValidation);
}

export function validationOrExit<T>(command: Command, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    validationExit(command, error);
  }
}

export async function waitAfterCreate(
  env: Envelope,
  opts: RunOpts,
  config: WaitAfterCreateConfig,
): Promise<never> {
  const id = stringAt(env, config.idKeys);
  if (!id) {
    emitAndExit(
      validationError(config.commandName, config.missingIdMessage),
      ExitCode.InputValidation,
    );
  }
  const result = await waitForOperation(
    {
      operation: config.operation,
      json: JSON.stringify({ path: { [config.pathKey]: id } }),
      statusPath: config.statusPath,
      success: config.success,
      failure: config.failure,
    },
    { runOperation: (operationId, input) => runOperation(operationId, input, opts) },
  );
  emitAndExit(result.env, result.exitCode);
}

function stringAt(env: Envelope, keys: string[]): string | null {
  if (!env.ok || !isRecord(env.data)) return null;
  const data = env.data;
  for (const key of keys) if (typeof data[key] === "string") return data[key];
  return null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

export function requiredPath(value: string | undefined, label: string): string {
  return resolve(required(value, label));
}

export function readJsonBody(flags: JsonBodyFlags, requiredBody = true): Record<string, unknown> {
  if (flags.json !== undefined && flags.jsonFile !== undefined)
    throw new Error("Use --json or --json-file, not both");
  const raw = flags.jsonFile !== undefined ? readFileSync(flags.jsonFile, "utf8") : flags.json;
  if (raw === undefined) {
    if (requiredBody) throw new Error("--json or --json-file is required");
    return {};
  }
  return parseJsonRecord(raw, "JSON", "JSON must be an object");
}

export function compact(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(record).filter(([, value]) => value !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function compactInput(input: AgentInput): AgentInput {
  const out: AgentInput = {};
  if (input.path !== undefined) out.path = input.path;
  if (input.query !== undefined) out.query = input.query;
  if (input.body !== undefined) out.body = input.body;
  if (input.headers !== undefined) out.headers = input.headers;
  if (input.files !== undefined) out.files = input.files;
  return out;
}
