import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { runOperation } from "../../core/client";
import { emitAndExit, exitCodeForError, validationError } from "../../core/errors";
import { ExitCode } from "../../core/types";
import type { AgentInput, Envelope, RunOpts } from "../../core/types";

export interface TtsFlags {
  voiceId?: string;
  voice?: string;
  text?: string;
  textFile?: string;
  model?: string;
  format?: string;
  language?: string;
  timestamps?: boolean;
  stream?: boolean;
  optimizeStreamingLatency?: string | number;
  enableLogging?: boolean;
}

export function buildTtsInput(flags: TtsFlags): { operationId: string; input: AgentInput } {
  const text = readText(flags.text, flags.textFile, "tts");
  const body = compact({ text, model_id: flags.model, language_code: flags.language });
  const query = compact({
    output_format: flags.format,
    optimize_streaming_latency: numberValue(flags.optimizeStreamingLatency),
    enable_logging: flags.enableLogging,
  });
  return {
    operationId: ttsOperationId(Boolean(flags.stream), Boolean(flags.timestamps)),
    input: compactInput({ path: { voice_id: required(flags.voiceId, "--voice-id") }, query, body }),
  };
}

export function registerTtsCommand(program: Command, addCommonFlags: (command: Command) => Command): void {
  const tts = program.command("tts").description("Text to speech");
  const configure = (command: Command, stream: boolean) =>
    addCommonFlags(
      command
        .option("--voice-id <id>")
        .option("--voice <name>")
        .option("--text <text>")
        .option("--text-file <path>")
        .option("--model <id>")
        .option("--format <format>")
        .option("--language <code>")
        .option("--timestamps")
        .option("--optimize-streaming-latency <n>")
        .option("--enable-logging")
        .action(async (options: TtsFlags, command: Command) => {
          const merged = mergedOptions(command) as TtsFlags;
          await runTts({ ...merged, stream }, command);
        }),
    );
  configure(tts, false);
  configure(tts.command("stream"), true);
}

async function runTts(flags: TtsFlags, command: Command): Promise<never> {
  const opts = runOpts(command);
  const voiceId = await resolveVoiceId(flags, opts, commandName(command));
  try {
    const built = buildTtsInput({ ...flags, voiceId });
    const env = await runOperation(built.operationId, built.input, opts);
    emit(env);
  } catch (error) {
    emitAndExit(validationError(commandName(command), message(error)), ExitCode.InputValidation);
  }
}

function ttsOperationId(stream: boolean, timestamps: boolean): string {
  if (stream && timestamps) return "text_to_speech_stream_with_timestamps";
  if (stream) return "text_to_speech_stream";
  if (timestamps) return "text_to_speech_full_with_timestamps";
  return "text_to_speech_full";
}

async function resolveVoiceId(flags: TtsFlags, opts: RunOpts, cmd: string): Promise<string> {
  if (flags.voiceId) return flags.voiceId;
  if (!flags.voice) return required(undefined, "--voice-id or --voice");
  const env = await runOperation("get_voices", {}, opts);
  if (!env.ok) emit(env);
  const matches = exactVoiceMatches(flags.voice, voicesFrom(env));
  if (matches.length === 1) return String(matches[0]?.voice_id);
  const candidates = candidateNames(flags.voice, voicesFrom(env));
  emitAndExit(
    validationError(
      cmd,
      matches.length === 0
        ? `No voice named "${flags.voice}"${candidates}`
        : `Ambiguous voice name "${flags.voice}"${candidates}`,
    ),
    ExitCode.InputValidation,
  );
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

interface Voice {
  name?: unknown;
  voice_id?: unknown;
}

function voicesFrom(env: Envelope): Voice[] {
  if (!env.ok) return [];
  const data = env.data as { voices?: unknown } | undefined;
  return Array.isArray(data?.voices) ? (data.voices as Voice[]) : [];
}

function readText(text: string | undefined, file: string | undefined, label: string): string {
  if (text !== undefined && file !== undefined) throw new Error(`elv ${label}: use --text or --text-file, not both`);
  if (text !== undefined) return text;
  if (file !== undefined) return readFileSync(file, "utf8");
  throw new Error(`elv ${label}: --text or --text-file is required`);
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
  const maxCredits = numberValue(optionString(opts.maxCredits));
  return {
    dryRun: Boolean(opts.dryRun),
    yes: Boolean(opts.yes),
    retryPost: Boolean(opts.retryPost),
    hash: Boolean(opts.hash),
    out: optionString(opts.out),
    baseUrl: optionString(opts.baseUrl),
    profile: optionString(opts.profile),
    maxCredits,
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
