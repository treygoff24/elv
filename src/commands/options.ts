import type { Command } from "commander";
import type { RunOpts } from "../core/types";

export function addCommonFlags(command: Command): Command {
  return command
    .option("--dry-run", "preview without network")
    .option("--yes", "confirm gated operations")
    .option("--max-credits <credits>", "credit ceiling")
    .option("--out <path>", "output file or directory")
    .option("--base-url <url>", "override API base URL")
    .option("--profile <name>", "config profile")
    .option("--debug", "debug logs to stderr")
    .option("--retry-post", "retry POST requests");
}

export function mergedOptions(command: Command): Record<string, unknown> {
  const chain: Command[] = [];
  for (let current: Command | null = command; current; current = current.parent)
    chain.unshift(current);
  return Object.assign({}, ...chain.map((current) => current.opts()));
}

export function runOptsFromCommand(command: Command): RunOpts {
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

export function optionString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function optionStrings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

export function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function numberValue(value: string | number | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected number, got ${value}`);
  return parsed;
}
