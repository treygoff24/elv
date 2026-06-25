import { resolve } from "node:path";
import type { Command } from "commander";
import { runOperation } from "../../core/client";
import { emitAndExit, exitCodeForError, validationError } from "../../core/errors";
import { waitForOperation } from "../wait";
import { ExitCode } from "../../core/types";
import type { AgentInput, Envelope, RunOpts } from "../../core/types";

export interface DubbingCreateFlags {
  file?: string;
  source?: string;
  target?: string;
  name?: string;
  wait?: boolean;
}

export interface DubbingIdFlags {
  id?: string;
  language?: string;
  limit?: string | number;
}

export function buildDubbingCreateInput(flags: DubbingCreateFlags): { operationId: string; input: AgentInput } {
  return {
    operationId: "create_dubbing",
    input: compactInput({
      files: flags.file ? { file: resolve(flags.file) } : undefined,
      body: compact({ name: flags.name, source_lang: flags.source, target_lang: flags.target }),
    }),
  };
}

export function buildDubbingGetInput(flags: DubbingIdFlags): { operationId: string; input: AgentInput } {
  return { operationId: "get_dubbed_metadata", input: { path: { dubbing_id: required(flags.id, "--id") } } };
}

export function buildDubbingAudioInput(flags: DubbingIdFlags): { operationId: string; input: AgentInput } {
  return {
    operationId: "get_dubbed_file",
    input: { path: { dubbing_id: required(flags.id, "--id"), language_code: required(flags.language, "--language") } },
  };
}

export function buildDubbingListInput(flags: DubbingIdFlags): { operationId: string; input: AgentInput } {
  return { operationId: "list_dubs", input: compactInput({ query: compact({ page_size: numberValue(flags.limit) }) }) };
}

export function registerDubbingCommand(program: Command, addCommonFlags: (command: Command) => Command): void {
  const dubbing = program.command("dubbing").description("Dubbing");
  addCommonFlags(
    dubbing
      .command("create")
      .option("--file <path>")
      .option("--source <code>")
      .option("--target <code>")
      .option("--name <name>")
      .option("--wait")
      .action(async (options: DubbingCreateFlags, command: Command) => {
        try {
          const opts = runOpts(command);
          const built = buildDubbingCreateInput(options);
          const env = await runOperation(built.operationId, built.input, opts);
          if (!options.wait || !env.ok) emit(env);
          await waitForDubbing(env, opts);
        } catch (error) {
          emitAndExit(validationError(commandName(command), message(error)), ExitCode.InputValidation);
        }
      }),
  );
  addCommonFlags(dubbing.command("get").option("--id <id>").action((options: DubbingIdFlags, command: Command) => runBuilt(buildDubbingGetInput, options, command)));
  addCommonFlags(dubbing.command("audio").option("--id <id>").option("--language <code>").action((options: DubbingIdFlags, command: Command) => runBuilt(buildDubbingAudioInput, options, command)));
  addCommonFlags(dubbing.command("list").option("--limit <n>").action((options: DubbingIdFlags, command: Command) => runBuilt(buildDubbingListInput, options, command)));
}

async function waitForDubbing(env: Envelope, opts: RunOpts): Promise<never> {
  const id = stringAt(env, ["dubbing_id", "id"]);
  if (!id) emitAndExit(validationError("elv dubbing create", "--wait could not find a dubbing id in the response"), ExitCode.InputValidation);
  const result = await waitForOperation(
    {
      operation: "get_dubbed_metadata",
      json: JSON.stringify({ path: { dubbing_id: id } }),
      statusPath: "$.data.status",
      success: "dubbed",
      failure: "failed",
    },
    { runOperation: (operationId, input) => runOperation(operationId, input, opts) },
  );
  emitAndExit(result.env, result.exitCode);
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

function stringAt(env: Envelope, keys: string[]): string | null {
  if (!env.ok || !env.data || typeof env.data !== "object") return null;
  const data = env.data as Record<string, unknown>;
  for (const key of keys) if (typeof data[key] === "string") return data[key];
  return null;
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
