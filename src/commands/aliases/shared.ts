import type { Command } from "commander";
import { emitAndExit, exitCodeForError } from "../../core/errors";
import { ExitCode } from "../../core/types";
import type { AgentInput, Envelope, RunOpts, SuccessEnvelope } from "../../core/types";

export function mergedOptions(command: Command): Record<string, unknown> {
  const chain: Command[] = [];
  for (let current: Command | null = command; current; current = current.parent) chain.unshift(current);
  return Object.assign({}, ...chain.map((current) => current.opts()));
}

export function runOpts(command: Command): RunOpts {
  const opts = mergedOptions(command);
  return {
    dryRun: Boolean(opts.dryRun),
    yes: Boolean(opts.yes),
    retryPost: Boolean(opts.retryPost),
    hash: Boolean(opts.hash),
    out: optionString(opts.out),
    baseUrl: optionString(opts.baseUrl),
    profile: optionString(opts.profile),
    maxCredits: numberValue(optionString(opts.maxCredits)),
  };
}

export function paginationOpts(command: Command): { all?: boolean; limit?: number; saveJson?: string } {
  const opts = mergedOptions(command);
  return {
    all: opts.all ? true : undefined,
    limit: numberValue(optionString(opts.limit)),
    saveJson: optionString(opts.saveJson),
  };
}

export function addPaginationFlags(command: Command): Command {
  return command
    .option("--limit <n>", "max items returned (also sets page size)")
    .option("--all", "fetch every page and save the full set to a file (requires --save-json or --out)")
    .option("--save-json <path>", "write the full JSON result to this path")
    .option("--fields <csv>", "project list items to a comma-separated set of fields (compact inline output)");
}

export function fieldsOpt(command: Command): string[] | undefined {
  const raw = optionString(mergedOptions(command).fields);
  if (!raw) return undefined;
  const fields = raw.split(",").map((field) => field.trim()).filter(Boolean);
  return fields.length ? fields : undefined;
}

// Resolve the fetch options for a list command. --fields returns a projected
// inline result, so it is mutually exclusive with the bulk-to-disk flags
// (--all / --save-json) — combining them would silently ignore the persistence
// request. Throwing here surfaces as a validation_error (exit 2) via runBuilt.
export function resolveListOpts(command: Command): {
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
    return { ...data, [key]: (data[key] as unknown[]).map((item) => pickFields(item, fields)) };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function optionString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function commandName(command: Command): string {
  return `elv ${command.name()}`;
}

export function emit(env: Envelope): never {
  emitAndExit(env, env.ok ? ExitCode.Success : exitCodeForError(env.error, env.http?.status ?? undefined));
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

export function compact(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(record).filter(([, value]) => value !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function compactInput(input: AgentInput): AgentInput {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as AgentInput;
}

export function numberValue(value: string | number | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected number, got ${value}`);
  return parsed;
}
