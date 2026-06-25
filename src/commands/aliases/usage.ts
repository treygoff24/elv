import type { Command } from "commander";
import { runOperation } from "../../core/client";
import { emitAndExit, exitCodeForError, validationError } from "../../core/errors";
import { ExitCode } from "../../core/types";
import type { AgentInput, Envelope, RunOpts } from "../../core/types";

export interface UsageFlags {
  from?: string;
  to?: string;
  breakdown?: string;
  metric?: string;
}

export function buildUsageInput(flags: UsageFlags): { operationId: string; input: AgentInput } {
  if (!flags.from && !flags.to) return { operationId: "get_user_subscription_info", input: {} };
  return {
    operationId: "usage_characters",
    input: {
      query: compact({
        start_unix: dateMs(required(flags.from, "--from")),
        end_unix: dateMs(required(flags.to, "--to")),
        breakdown_type: flags.breakdown,
        metric: flags.metric,
      }) ?? {},
    },
  };
}

export function registerUsageCommand(program: Command, addCommonFlags: (command: Command) => Command): void {
  addCommonFlags(
    program
      .command("usage")
      .description("Usage and subscription")
      .option("--from <YYYY-MM-DD>")
      .option("--to <YYYY-MM-DD>")
      .option("--breakdown <type>")
      .option("--metric <metric>")
      .action((options: UsageFlags, command: Command) => runBuilt(options, command)),
  );
}

async function runBuilt(flags: UsageFlags, command: Command): Promise<never> {
  try {
    const built = buildUsageInput(flags);
    const env = await runOperation(built.operationId, built.input, runOpts(command));
    emit(env);
  } catch (error) {
    emitAndExit(validationError(commandName(command), message(error)), ExitCode.InputValidation);
  }
}

function dateMs(value: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`Invalid date: ${value}`);
  return ms;
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function compact(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(record).filter(([, value]) => value !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
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
