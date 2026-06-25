import type { Command } from "commander";
import { runOperation } from "../../core/client";
import { emitAndExit, validationError } from "../../core/errors";
import { ExitCode } from "../../core/types";
import type { AgentInput } from "../../core/types";
import { commandName, compact, emit, message, required, runOpts } from "./shared";

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
