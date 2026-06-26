import type { Command } from "commander";
import { compact, required, runAlias, type BuiltOperation } from "./shared";

export interface UsageFlags {
  from?: string;
  to?: string;
  breakdown?: string;
  metric?: string;
}

export function buildUsageInput(flags: UsageFlags): BuiltOperation {
  if (!flags.from && !flags.to) return { operationId: "get_user_subscription_info", input: {} };
  return {
    operationId: "usage_characters",
    input: {
      query:
        compact({
          start_unix: dateMs(required(flags.from, "--from")),
          end_unix: dateMs(required(flags.to, "--to")),
          breakdown_type: flags.breakdown,
          metric: flags.metric,
        }) ?? {},
    },
  };
}

export function registerUsageCommand(
  program: Command,
  addCommonFlags: (command: Command) => Command,
): void {
  addCommonFlags(
    program
      .command("usage")
      .description("Usage and subscription")
      .option("--from <YYYY-MM-DD>", "usage range start date (requires --to)")
      .option("--to <YYYY-MM-DD>", "usage range end date (requires --from)")
      .option("--breakdown <type>", "usage breakdown type for character usage")
      .option("--metric <metric>", "usage metric to report")
      .action((options: UsageFlags, command: Command) =>
        runAlias(buildUsageInput, options, command),
      ),
  );
}

function dateMs(value: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`Invalid date: ${value}`);
  return ms;
}
