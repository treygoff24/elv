import type { Command } from "commander";
import { runOperation } from "../../core/client";
import type { SuccessEnvelope } from "../../core/types";
import { isRecord } from "../../util/json";
import type { CliOptionValues } from "../options";
import {
  type BuiltOperation,
  addWaitFlags,
  compact,
  compactInput,
  emit,
  requiredPath,
  aliasRunOpts,
  validationOrExit,
  waitAfterCreate,
  waitTiming,
  type WaitFlags,
} from "./shared";

interface SttFlags extends Pick<CliOptionValues, "model" | "language">, WaitFlags {
  file?: string;
  timestamps?: string;
  diarize?: boolean;
  webhook?: boolean | string;
  webhookId?: string;
  tokenEnv?: string;
}

export function buildSttInput(flags: SttFlags): BuiltOperation {
  if (typeof flags.webhook === "string") {
    throw new Error(
      "--webhook no longer accepts a URL; configure a workspace webhook, then use --webhook [--webhook-id ID]",
    );
  }
  if (flags.webhookId && flags.webhook !== true) {
    throw new Error("--webhook-id requires --webhook");
  }
  const token = flags.tokenEnv ? process.env[flags.tokenEnv] : undefined;
  if (flags.tokenEnv && !token) {
    throw new Error(`--token-env ${flags.tokenEnv} is unset or empty; set it and retry`);
  }
  return {
    operationId: "speech_to_text",
    input: compactInput({
      files: { file: requiredPath(flags.file, "--file") },
      query: compact({ token }),
      body: compact({
        model_id: flags.model,
        timestamps_granularity: flags.timestamps,
        diarize: flags.diarize,
        language_code: flags.language,
        webhook: flags.webhook === true ? true : undefined,
        webhook_id: flags.webhookId,
      }),
    }),
  };
}

export function registerSttCommand(
  program: Command,
  addCommonFlags: (command: Command) => Command,
): void {
  addCommonFlags(
    addWaitFlags(
      program
        .command("stt")
        .description("Speech to text")
        .option("--file <path>", "audio file to transcribe")
        .option("--model <id>", "STT model id")
        .option("--timestamps <granularity>", "timestamp granularity: none, word, character")
        .option("--diarize", "enable speaker diarization")
        .option("--language <code>", "expected language code")
        .option(
          "--webhook [legacy-url]",
          "deliver asynchronously to a configured workspace webhook",
        )
        .option("--webhook-id <id>", "configured workspace webhook id (requires --webhook)")
        .option("--token-env <name>", "read a single-use STT token from an environment variable"),
      "return completed transcripts directly; otherwise poll a returned transcription id",
    ).action(async (options: SttFlags, command: Command) => {
      const opts = validationOrExit(command, () => aliasRunOpts(command));
      const built = validationOrExit(command, () => buildSttInput(options));
      const timing = validationOrExit(command, () => waitTiming(options));
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
        isComplete: (result) => completedTranscript(result, options.webhook === true),
        timing,
      });
    }),
  );
}

function completedTranscript(env: SuccessEnvelope, webhook: boolean): boolean {
  if (env.http?.status !== 200) return false;
  const data = env.data;
  if (isRecord(data)) {
    const chunk = (value: unknown): boolean =>
      isRecord(value) && typeof value.text === "string" && Array.isArray(value.words);
    if (chunk(data) || (Array.isArray(data.transcripts) && data.transcripts.every(chunk)))
      return true;
  }
  const jsonFiles =
    env.files?.filter((file) => file.mime === "application/json" && !file.partial) ?? [];
  if (!jsonFiles.length) return false;
  const keys = env.data_summary?.preview ?? [];
  if ((keys.includes("text") && keys.includes("words")) || keys.includes("transcripts"))
    return true;
  // Private spills intentionally omit key previews. These HTTP 200 contracts
  // return completed transcripts; retain the private file without rereading it.
  return (
    jsonFiles.some((file) => file.sensitive) &&
    (env.operation_id === "get_transcript_by_id" ||
      (env.operation_id === "speech_to_text" && !webhook))
  );
}
