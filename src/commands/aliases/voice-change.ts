import { resolve } from "node:path";
import type { Command } from "commander";
import { runOperation } from "../../core/client";
import { emitAndExit, validationError } from "../../core/errors";
import { ExitCode } from "../../core/types";
import type { AgentInput, Envelope, RunOpts } from "../../core/types";
import { commandName, compact, compactInput, emit, mergedOptions, message, required, runOpts } from "./shared";
import { findMatchingVoices, RESOLVER_PAGE_SIZE, type VoiceRecord } from "./voices";

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
        .option("--voice-id <id>", "target ElevenLabs voice id")
        .option("--voice <name>", "resolve target voice by name (exact, else unique substring) instead of id")
        .option("--file <path>", "input audio file to convert")
        .option("--model <id>", "speech-to-speech model id")
        .option("--format <format>", "output audio format (output_format)")
        .option("--remove-background-noise", "remove background noise before conversion")
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
  const env = await runOperation("get_user_voices_v2", { query: { search: flags.voice } }, { ...opts, inline: true, limit: RESOLVER_PAGE_SIZE });
  if (!env.ok) emit(env);
  const voices = voicesFrom(env);
  const matches = findMatchingVoices(flags.voice, voices);
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

function candidateNames(name: string, voices: VoiceRecord[]): string {
  const needle = name.toLowerCase();
  const names = voices
    .filter((voice) => String(voice.name ?? "").toLowerCase().includes(needle))
    .map((voice) => `${voice.name} (${voice.voice_id})`)
    .slice(0, 10);
  return names.length ? `; candidates: ${names.join(", ")}` : "";
}

function voicesFrom(env: Envelope): VoiceRecord[] {
  if (!env.ok) return [];
  const data = env.data as { voices?: unknown } | undefined;
  return Array.isArray(data?.voices) ? (data.voices as VoiceRecord[]) : [];
}
