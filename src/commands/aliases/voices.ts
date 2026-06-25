import { resolve } from "node:path";
import type { Command } from "commander";
import { runOperation } from "../../core/client";
import { emitAndExit, exitCodeForError, validationError } from "../../core/errors";
import { ExitCode } from "../../core/types";
import type { AgentInput, Envelope, RunOpts, SuccessEnvelope } from "../../core/types";

export interface VoicesFlags {
  query?: string;
  voiceId?: string;
  name?: string;
  file?: string;
  removeBackgroundNoise?: boolean;
  description?: string;
}

export interface VoiceRecord {
  name?: unknown;
  voice_id?: unknown;
  [key: string]: unknown;
}

export function buildVoicesListInput(_flags: VoicesFlags): { operationId: string; input: AgentInput } {
  return { operationId: "get_voices", input: {} };
}

export function buildVoicesFindInput(_flags: VoicesFlags): { operationId: string; input: AgentInput } {
  return { operationId: "get_voices", input: {} };
}

export function buildVoicesGetInput(flags: VoicesFlags): { operationId: string; input: AgentInput } {
  return { operationId: "get_voice_by_id", input: { path: { voice_id: required(flags.voiceId, "--voice-id") } } };
}

export function buildVoicesCloneInstantInput(flags: VoicesFlags): { operationId: string; input: AgentInput } {
  return {
    operationId: "add_voice",
    input: compactInput({
      files: { files: resolve(required(flags.file, "--file")) },
      body: compact({ name: required(flags.name, "--name"), remove_background_noise: flags.removeBackgroundNoise, description: flags.description }),
    }),
  };
}

export function findMatchingVoices(query: string, voices: VoiceRecord[]): VoiceRecord[] {
  const needle = query.toLowerCase();
  const exact = voices.filter((voice) => String(voice.name ?? "").toLowerCase() === needle);
  if (exact.length) return exact;
  return voices.filter((voice) => String(voice.name ?? "").toLowerCase().includes(needle));
}

export function registerVoicesCommand(program: Command, addCommonFlags: (command: Command) => Command): void {
  const voices = program.command("voices").description("Voices");
  addCommonFlags(voices.command("list").option("--limit <n>").action((options: VoicesFlags, command: Command) => runBuilt(buildVoicesListInput, options, command)));
  addCommonFlags(
    voices
      .command("find <query>")
      .action(async (query: string, options: VoicesFlags, command: Command) => {
        const opts = { ...options, query };
        await runFind(opts, command);
      }),
  );
  addCommonFlags(voices.command("get").option("--voice-id <id>").action((options: VoicesFlags, command: Command) => runBuilt(buildVoicesGetInput, options, command)));
  addCommonFlags(
    voices
      .command("clone-instant")
      .option("--name <name>")
      .option("--file <path>")
      .option("--remove-background-noise")
      .option("--description <text>")
      .action((options: VoicesFlags, command: Command) => runBuilt(buildVoicesCloneInstantInput, options, command)),
  );
}

async function runFind(flags: VoicesFlags, command: Command): Promise<never> {
  try {
    const built = buildVoicesFindInput(flags);
    const env = await runOperation(built.operationId, built.input, runOpts(command));
    if (!env.ok) emit(env);
    const data = env.data as { voices?: unknown } | undefined;
    const voices = Array.isArray(data?.voices) ? (data.voices as VoiceRecord[]) : [];
    const next: SuccessEnvelope = { ...env, data: { ...data, voices: findMatchingVoices(required(flags.query, "query"), voices) } };
    emit(next);
  } catch (error) {
    emitAndExit(validationError(commandName(command), message(error)), ExitCode.InputValidation);
  }
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

function numberValue(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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
