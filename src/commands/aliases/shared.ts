import type { Command } from "commander";
import { emitAndExit, exitCodeForError } from "../../core/errors";
import { ExitCode } from "../../core/types";
import type { AgentInput, Envelope, RunOpts } from "../../core/types";

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
    .option("--save-json <path>", "write the full JSON result to this path");
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
