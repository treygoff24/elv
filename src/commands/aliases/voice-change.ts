import { resolve } from "node:path";
import type { Command } from "commander";
import { runOperation } from "../../core/client";
import type { AgentInput } from "../../core/types";
import { mergedOptions } from "../options";
import {
  commandName,
  compact,
  compactInput,
  emit,
  required,
  aliasRunOpts,
  validationOrExit,
} from "./shared";
import { resolveVoiceId } from "./voices";

export interface VoiceChangeFlags {
  voiceId?: string;
  voice?: string;
  file?: string;
  model?: string;
  format?: string;
  stream?: boolean;
  removeBackgroundNoise?: boolean;
}

export function buildVoiceChangeInput(flags: VoiceChangeFlags): {
  operationId: string;
  input: AgentInput;
} {
  return {
    operationId: flags.stream ? "speech_to_speech_stream" : "speech_to_speech_full",
    input: compactInput({
      path: { voice_id: required(flags.voiceId, "--voice-id") },
      query: compact({ output_format: flags.format }),
      files: { audio: resolve(required(flags.file, "--file")) },
      body: compact({
        model_id: flags.model,
        remove_background_noise: flags.removeBackgroundNoise,
      }),
    }),
  };
}

export function registerVoiceChangeCommand(
  program: Command,
  addCommonFlags: (command: Command) => Command,
): void {
  const root = program.command("voice-change").description("Speech to speech voice conversion");
  const configure = (command: Command, stream: boolean) =>
    addCommonFlags(
      command
        .option("--voice-id <id>", "target ElevenLabs voice id")
        .option(
          "--voice <name>",
          "resolve target voice by name (exact, else unique substring) instead of id",
        )
        .option("--file <path>", "input audio file to convert")
        .option("--model <id>", "speech-to-speech model id")
        .option("--format <format>", "output audio format (output_format)")
        .option("--remove-background-noise", "remove background noise before conversion")
        .action(async (_options: VoiceChangeFlags, command: Command) => {
          const merged = mergedOptions(command) as VoiceChangeFlags;
          await runBuilt({ ...merged, stream }, command);
        }),
    );
  configure(root, false);
  configure(root.command("stream").description("Speech to speech (streaming)"), true);
}

async function runBuilt(flags: VoiceChangeFlags, command: Command): Promise<never> {
  const opts = validationOrExit(command, () => aliasRunOpts(command));
  const voiceId = await resolveVoiceId(flags, opts, commandName(command));
  const built = validationOrExit(command, () => buildVoiceChangeInput({ ...flags, voiceId }));
  const env = await runOperation(built.operationId, built.input, opts);
  emit(env);
}
