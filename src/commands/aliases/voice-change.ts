import { resolve } from "node:path";
import type { Command } from "commander";
import { runOperation } from "../../core/client";
import { emitAndExit, exitCodeForError, validationError } from "../../core/errors";
import { ExitCode } from "../../core/types";
import type { AgentInput, Envelope, RunOpts } from "../../core/types";

export interface VoiceChangeFlags {
  voiceId?: string;
  voice?: string;
  file?: string;
  model?: string;
  format?: string;
  stream?: boolean;
  removeBackgroundNoise?: boolean;
}

export function buildVoiceChangeInput(flags: VoiceChangeFlags): { operationId: string; input: AgentInput } {
  return {
    operationId: flags.stream ? "speech_to_speech_stream" : "speech_to_speech_full",
    input: compactInput({
      path: { voice_id: required(flags.voiceId, "--voice-id") },
      query: compact({ output_format: flags.format }),
      files: { audio: resolve(required(flags.file, "--file")) },
      body: compact({ model_id: flags.model, remove_background_noise: flags.removeBackgroundNoise }),
    }),
  };
}

export function registerVoiceChangeCommand(program: Command, addCommonFlags: (command: Command) => Command): void {
  const root = program.command("voice-change").description("Speech to speech voice conversion");
  const configure = (command: Command, stream: boolean) =>
    addCommonFlags(
      command
        .option("--voice-id <id>")
        .option("--voice <name>")
        .option("--file <path>")
        .option("--model <id>")
        .option("--format <format>")
        .option("--remove-background-noise")
        .action(async (options: VoiceChangeFlags, command: Command) => {
          const merged = mergedOptions(command) as VoiceChangeFlags;
          await runBuilt({ ...merged, stream }, command);
        }),
    );
  configure(root, false);
  configure(root.command("stream"), true);
}

async function runBuilt(flags: VoiceChangeFlags, command: Command): Promise<never> {
  const opts = runOpts(command);
  const voiceId = await resolveVoiceId(flags, opts, commandName(command));
  try {
    const built = buildVoiceChangeInput({ ...flags, voiceId });
    const env = await runOperation(built.operationId, built.input, opts);
    emit(env);
  } catch (error) {
    emitAndExit(validationError(commandName(command), message(error)), ExitCode.InputValidation);
  }
}

async function resolveVoiceId(flags: VoiceChangeFlags, opts: RunOpts, cmd: string): Promise<string> {
  if (flags.voiceId) return flags.voiceId;
  if (!flags.voice) return required(undefined, "--voice-id or --voice");
  const env = await runOperation("get_voices", {}, opts);
  if (!env.ok) emit(env);
  const voices = voicesFrom(env);
  const matches = exactVoiceMatches(flags.voice, voices);
  if (matches.length === 1) return String(matches[0]?.voice_id);
  emitAndExit(
    validationError(
      cmd,
      matches.length === 0
        ? `No voice named "${flags.voice}"${candidateNames(flags.voice, voices)}`
        : `Ambiguous voice name "${flags.voice}"${candidateNames(flags.voice, voices)}`,
    ),
    ExitCode.InputValidation,
  );
}

interface Voice {
  name?: unknown;
  voice_id?: unknown;
}

function exactVoiceMatches(name: string, voices: Voice[]): Voice[] {
  const needle = name.toLowerCase();
  return voices.filter((voice) => String(voice.name ?? "").toLowerCase() === needle);
}

function candidateNames(name: string, voices: Voice[]): string {
  const needle = name.toLowerCase();
  const names = voices
    .filter((voice) => String(voice.name ?? "").toLowerCase().includes(needle))
    .map((voice) => `${voice.name} (${voice.voice_id})`)
    .slice(0, 10);
  return names.length ? `; candidates: ${names.join(", ")}` : "";
}

function voicesFrom(env: Envelope): Voice[] {
  if (!env.ok) return [];
  const data = env.data as { voices?: unknown } | undefined;
  return Array.isArray(data?.voices) ? (data.voices as Voice[]) : [];
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
