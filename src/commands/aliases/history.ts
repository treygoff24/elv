import type { Command } from "commander";
import { runOperation } from "../../core/client";
import { emitAndExit, exitCodeForError, validationError } from "../../core/errors";
import { ExitCode } from "../../core/types";
import type { AgentInput, Envelope, RunOpts } from "../../core/types";

export interface HistoryFlags {
  id?: string;
  limit?: string | number;
}

export function buildHistoryListInput(flags: HistoryFlags): { operationId: string; input: AgentInput } {
  return { operationId: "get_speech_history", input: compactInput({ query: compact({ page_size: numberValue(flags.limit) }) }) };
}

export function buildHistoryAudioInput(flags: HistoryFlags): { operationId: string; input: AgentInput } {
  return { operationId: "get_audio_full_from_speech_history_item", input: { path: { history_item_id: required(flags.id, "--id") } } };
}

export function buildHistoryDeleteInput(flags: HistoryFlags): { operationId: string; input: AgentInput } {
  return { operationId: "delete_speech_history_item", input: { path: { history_item_id: required(flags.id, "--id") } } };
}

export function registerHistoryCommand(program: Command, addCommonFlags: (command: Command) => Command): void {
  const history = program.command("history").description("Speech history");
  addCommonFlags(history.command("list").option("--limit <n>").action((options: HistoryFlags, command: Command) => runBuilt(buildHistoryListInput, options, command)));
  addCommonFlags(history.command("audio").option("--id <id>").action((options: HistoryFlags, command: Command) => runBuilt(buildHistoryAudioInput, options, command)));
  addCommonFlags(history.command("delete").option("--id <id>").action((options: HistoryFlags, command: Command) => runBuilt(buildHistoryDeleteInput, options, command)));
}

async function runBuilt<T>(builder: (flags: T) => { operationId: string; input: AgentInput }, flags: T, command: Command): Promise<never> {
  try {
    const built = builder(flags);
    const env = await runOperation(built.operationId, built.input, runOpts(command));
    emit(env);
  } catch (error) {
    emitAndExit(validationError(commandName(command), message(error)), ExitCode.InputValidation);
  }
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function numberValue(value: string | number | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected number, got ${value}`);
  return parsed;
}

function compact(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(record).filter(([, value]) => value !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function compactInput(input: AgentInput): AgentInput {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as AgentInput;
}

function runOpts(command: Command): RunOpts {
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

function mergedOptions(command: Command): Record<string, unknown> {
  const chain: Command[] = [];
  for (let current: Command | null = command; current; current = current.parent) chain.unshift(current);
  return Object.assign({}, ...chain.map((current) => current.opts()));
}

function optionString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function commandName(command: Command): string {
  return `elv ${command.name()}`;
}

function emit(env: Envelope): never {
  emitAndExit(env, env.ok ? ExitCode.Success : exitCodeForError(env.error, env.http?.status ?? undefined));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
