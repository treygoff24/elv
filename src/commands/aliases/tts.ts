import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { runOperation } from "../../core/client";
import { emitAndExit, validationError } from "../../core/errors";
import { ExitCode } from "../../core/types";
import type { AgentInput, Envelope, RunOpts } from "../../core/types";
import { commandName, compact, compactInput, emit, mergedOptions, message, numberValue, required, runOpts } from "./shared";

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
  const env = await runOperation("get_voices", {}, { ...opts, inline: true });
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
