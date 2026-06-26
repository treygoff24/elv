import { resolve } from "node:path";
import type { Command } from "commander";
import { runOperation } from "../../core/client";
import { emitAndExit, validationError } from "../../core/errors";
import { waitForOperation } from "../wait";
import { ExitCode } from "../../core/types";
import type { AgentInput, Envelope, RunOpts } from "../../core/types";
import { commandName, compact, compactInput, emit, message, required, runOpts } from "./shared";

export interface SttFlags {
  file?: string;
  model?: string;
  timestamps?: string;
  diarize?: boolean;
  language?: string;
  webhook?: string;
  wait?: boolean;
}

export function buildSttInput(flags: SttFlags): { operationId: string; input: AgentInput } {
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
        try {
          const opts = runOpts(command);
          const built = buildSttInput(options);
          const env = await runOperation(built.operationId, built.input, opts);
          if (!options.wait || !env.ok) emit(env);
          await waitForTranscript(env, opts);
        } catch (error) {
          emitAndExit(
            validationError(commandName(command), message(error)),
            ExitCode.InputValidation,
          );
        }
      }),
  );
}

async function waitForTranscript(env: Envelope, opts: RunOpts): Promise<never> {
  const id = stringAt(env, ["transcription_id", "transcript_id", "id"]);
  if (!id)
    emitAndExit(
      validationError("elv stt", "--wait could not find a transcription id in the response"),
      ExitCode.InputValidation,
    );
  const result = await waitForOperation(
    {
      operation: "get_transcript_by_id",
      json: JSON.stringify({ path: { transcription_id: id } }),
      statusPath: "$.data.status",
      success: "completed,succeeded,done",
      failure: "failed,error",
    },
    { runOperation: (operationId, input) => runOperation(operationId, input, opts) },
  );
  emitAndExit(result.env, result.exitCode);
}

function stringAt(env: Envelope, keys: string[]): string | null {
  if (!env.ok || !env.data || typeof env.data !== "object") return null;
  const data = env.data as Record<string, unknown>;
  for (const key of keys) if (typeof data[key] === "string") return data[key];
  return null;
}
