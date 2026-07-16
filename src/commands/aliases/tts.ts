import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { runOperation } from "../../core/client";
import { loadConfig } from "../../core/config";
import { mergedOptions, numberValue } from "../options";
import {
  type BuiltOperation,
  commandName,
  compact,
  compactInput,
  emit,
  required,
  aliasRunOpts,
  validationOrExit,
} from "./shared";
import { resolveVoiceId } from "./voices";
import type { VoiceSelector } from "./voices";

interface TtsFlags extends VoiceSelector {
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

export function buildTtsInput(flags: TtsFlags): BuiltOperation {
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

export function registerTtsCommand(
  program: Command,
  addCommonFlags: (command: Command) => Command,
): void {
  const tts = program.command("tts").description("Text to speech");
  const configure = (command: Command, stream: boolean) =>
    addCommonFlags(
      command
        .option("--voice-id <id>", "ElevenLabs voice id to synthesize with")
        .option(
          "--voice <name>",
          "resolve voice by name (exact, else unique substring) instead of id",
        )
        .option("--text <text>", "text to synthesize")
        .option("--text-file <path>", "read synthesis text from a file")
        .option("--model <id>", "TTS model id")
        .option("--format <format>", "output audio format (output_format)")
        .option("--language <code>", "language code for synthesis")
        .option("--timestamps", "include word/char alignment (writes .timestamps.json sidecar)")
        .option("--optimize-streaming-latency <n>", "streaming latency tradeoff level (0-4)")
        .option("--enable-logging", "enable provider request logging")
        .action(async (_options: TtsFlags, command: Command) => {
          const merged = mergedOptions(command) as TtsFlags;
          await runTts({ ...merged, stream }, command);
        }),
    );
  configure(tts, false);
  configure(tts.command("stream").description("Text to speech (streaming)"), true);
}

async function runTts(flags: TtsFlags, command: Command): Promise<never> {
  const opts = validationOrExit(command, () => aliasRunOpts(command));
  const model = validationOrExit(command, () => {
    return flags.model ?? loadConfig({ profile: opts.profile }).defaultTtsModelId;
  });
  const text = validationOrExit(command, () => readText(flags.text, flags.textFile, "tts"));
  const voiceId = await resolveVoiceId(flags, opts, commandName(command));
  const built = validationOrExit(command, () =>
    buildTtsInput({ ...flags, model, text, textFile: undefined, voiceId }),
  );
  const env = await runOperation(built.operationId, built.input, opts);
  emit(env);
}

function ttsOperationId(stream: boolean, timestamps: boolean): string {
  if (stream && timestamps) return "text_to_speech_stream_with_timestamps";
  if (stream) return "text_to_speech_stream";
  if (timestamps) return "text_to_speech_full_with_timestamps";
  return "text_to_speech_full";
}

function readText(text: string | undefined, file: string | undefined, label: string): string {
  if (text !== undefined && file !== undefined)
    throw new Error(`elv ${label}: use --text or --text-file, not both`);
  if (text !== undefined) return text;
  if (file !== undefined) return readFileSync(file, "utf8");
  throw new Error(`elv ${label}: --text or --text-file is required`);
}
