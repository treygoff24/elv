import type { Command } from "commander";
import { runOperation } from "../../core/client";
import { emitAndExit, exitCodeForError, validationError } from "../../core/errors";
import { ExitCode } from "../../core/types";
import type { AgentInput, Envelope, RunOpts } from "../../core/types";

export interface SfxFlags {
  prompt?: string;
  duration?: string | number;
  model?: string;
  format?: string;
  loop?: boolean;
}

export function buildSfxInput(flags: SfxFlags): { operationId: string; input: AgentInput } {
  return {
    operationId: "sound_generation",
    input: compactInput({
      query: compact({ output_format: flags.format }),
      body: compact({ text: required(flags.prompt, "--prompt"), duration_seconds: numberValue(flags.duration), model_id: flags.model, loop: flags.loop }),
    }),
  };
}

export function registerSfxCommand(program: Command, addCommonFlags: (command: Command) => Command): void {
  addCommonFlags(
    program
      .command("sfx")
      .description("Sound effects")
      .option("--prompt <text>")
      .option("--duration <seconds>")
      .option("--model <id>")
      .option("--format <format>")
      .option("--loop")
      .action(async (options: SfxFlags, command: Command) => runBuilt(options, command)),
  );
}

async function runBuilt(flags: SfxFlags, command: Command): Promise<never> {
  try {
    const built = buildSfxInput(flags);
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
