import type { Command } from "commander";
import { runOperation } from "../../core/client";
import { emitAndExit, exitCodeForError, validationError } from "../../core/errors";
import { ExitCode } from "../../core/types";
import type { AgentInput, Envelope, RunOpts } from "../../core/types";

export function buildModelsListInput(_flags: Record<string, never>): { operationId: string; input: AgentInput } {
  return { operationId: "get_models", input: {} };
}

export function registerModelsCommand(program: Command, addCommonFlags: (command: Command) => Command): void {
  addCommonFlags(program.command("models").description("Models").command("list").action((options: Record<string, never>, command: Command) => runBuilt(options, command)));
}

async function runBuilt(flags: Record<string, never>, command: Command): Promise<never> {
  try {
    const built = buildModelsListInput(flags);
    const env = await runOperation(built.operationId, built.input, runOpts(command));
    emit(env);
  } catch (error) {
    emitAndExit(validationError(commandName(command), message(error)), ExitCode.InputValidation);
  }
}

function runOpts(command: Command): RunOpts {
  const opts = mergedOptions(command);
  const maxCredits = typeof opts.maxCredits === "string" ? Number(opts.maxCredits) : undefined;
  return {
    dryRun: Boolean(opts.dryRun),
    yes: Boolean(opts.yes),
    retryPost: Boolean(opts.retryPost),
    hash: Boolean(opts.hash),
    out: optionString(opts.out),
    baseUrl: optionString(opts.baseUrl),
    profile: optionString(opts.profile),
    maxCredits: Number.isFinite(maxCredits) ? maxCredits : undefined,
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
