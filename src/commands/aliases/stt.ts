import { resolve } from "node:path";
import type { Command } from "commander";
import { runOperation } from "../../core/client";
import {
  type BuiltOperation,
  compact,
  compactInput,
  emit,
  required,
  aliasRunOpts,
  validationOrExit,
  waitAfterCreate,
} from "./shared";

export interface SttFlags {
  file?: string;
  model?: string;
  timestamps?: string;
  diarize?: boolean;
  language?: string;
  webhook?: string;
  wait?: boolean;
}

export function buildSttInput(flags: SttFlags): BuiltOperation {
  return {
    operationId: "speech_to_text",
    input: compactInput({
      files: { file: resolve(required(flags.file, "--file")) },
      body: compact({
        model_id: flags.model,
        timestamps_granularity: flags.timestamps,
        diarize: flags.diarize,
        language_code: flags.language,
        webhook: flags.webhook,
      }),
    }),
  };
}

export function registerSttCommand(
  program: Command,
  addCommonFlags: (command: Command) => Command,
): void {
  addCommonFlags(
    program
      .command("stt")
      .description("Speech to text")
      .option("--file <path>", "audio file to transcribe")
      .option("--model <id>", "STT model id")
      .option("--timestamps <granularity>", "timestamp granularity (e.g. word, segment)")
      .option("--diarize", "enable speaker diarization")
      .option("--language <code>", "expected language code")
      .option("--webhook <url>", "webhook URL for async completion")
      .option("--wait", "poll until transcription completes")
      .action(async (options: SttFlags, command: Command) => {
        const opts = validationOrExit(command, () => aliasRunOpts(command));
        const built = validationOrExit(command, () => buildSttInput(options));
        const env = await runOperation(built.operationId, built.input, opts);
        if (!options.wait || !env.ok) emit(env);
        await waitAfterCreate(env, opts, {
          commandName: "elv stt",
          idKeys: ["transcription_id", "transcript_id", "id"],
          missingIdMessage: "--wait could not find a transcription id in the response",
          operation: "get_transcript_by_id",
          pathKey: "transcription_id",
          statusPath: "$.data.status",
          success: "completed,succeeded,done",
          failure: "failed,error",
        });
      }),
  );
}
