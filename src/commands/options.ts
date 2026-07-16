import type { Command } from "commander";
import type { RunOpts } from "../core/types";
import type { PaginationOptions } from "../core/pagination";

export interface RunOptionValues extends Pick<
  RunOpts,
  "dryRun" | "yes" | "retryPost" | "hash" | "out" | "baseUrl" | "profile"
> {
  maxCredits?: string | RunOpts["maxCredits"];
}

export interface PaginationOptionValues extends Pick<PaginationOptions, "all" | "saveJson"> {
  limit?: string | PaginationOptions["limit"];
}

export interface CliOptionValues extends RunOptionValues, PaginationOptionValues {
  allowUnknown?: boolean;
  bodyJson?: string;
  cmd?: string;
  debug?: boolean;
  enableLogging?: boolean;
  example?: boolean;
  failure?: string;
  fields?: string;
  file?: string[] | string;
  format?: string;
  from?: string;
  group?: string;
  json?: string;
  jsonFile?: string;
  language?: string;
  list?: boolean;
  method?: string;
  model?: string;
  offline?: boolean;
  operation?: string;
  optimizeStreamingLatency?: string | number;
  path?: string[];
  query?: string[];
  raw?: boolean;
  removeBackgroundNoise?: boolean;
  risk?: string;
  search?: string;
  send?: string;
  sort?: string;
  statusPath?: string;
  stream?: string;
  stdinJson?: boolean;
  success?: string;
  text?: string;
  textFile?: string;
  timestamps?: boolean;
  timeoutMs?: string | number;
  intervalMs?: string | number;
  unpack?: boolean;
  uploads?: boolean;
  deprecated?: boolean;
  cost?: string;
  voice?: string;
  voiceId?: string;
}

export class OptionValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OptionValueError";
  }
}

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

export function mergedOptions(command: Command): CliOptionValues {
  const chain: Command[] = [];
  for (let current: Command | null = command; current; current = current.parent)
    chain.unshift(current);
  return Object.assign({}, ...chain.map((current) => current.opts()));
}

export function runOptsFromCommand(command: Command): RunOpts {
  return runOptsFromOptions(mergedOptions(command));
}

export function runOptsFromOptions(opts: RunOptionValues): RunOpts {
  return {
    dryRun: Boolean(opts.dryRun),
    yes: Boolean(opts.yes),
    retryPost: Boolean(opts.retryPost),
    hash: Boolean(opts.hash),
    out: optionString(opts.out),
    baseUrl: optionString(opts.baseUrl),
    profile: optionString(opts.profile),
    maxCredits: numberValue(opts.maxCredits),
  };
}

export function paginationOptionsFromCommand(command: Command): PaginationOptions {
  return paginationOptionsFromOptions(mergedOptions(command));
}

export function paginationOptionsFromOptions(opts: PaginationOptionValues): PaginationOptions {
  return {
    all: opts.all ? true : undefined,
    limit: numberValue(opts.limit),
    saveJson: optionString(opts.saveJson),
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

export function numberValue(value: unknown): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new OptionValueError(`Expected number, got ${value}`);
  return parsed;
}
