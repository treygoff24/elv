import { resolve } from "node:path";
import type { Command } from "commander";
import { runOperation } from "../../core/client";
import { emitAndExit, exitCodeForError, validationError } from "../../core/errors";
import { waitForOperation } from "../wait";
import { ExitCode } from "../../core/types";
import type { AgentInput, Envelope, RunOpts } from "../../core/types";

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

export function registerSttCommand(program: Command, addCommonFlags: (command: Command) => Command): void {
  addCommonFlags(
    program
      .command("stt")
      .description("Speech to text")
      .option("--file <path>")
      .option("--model <id>")
      .option("--timestamps <granularity>")
      .option("--diarize")
      .option("--language <code>")
      .option("--webhook <url>")
      .option("--wait")
      .action(async (options: SttFlags, command: Command) => {
        try {
          const opts = runOpts(command);
          const built = buildSttInput(options);
          const env = await runOperation(built.operationId, built.input, opts);
          if (!options.wait || !env.ok) emit(env);
          await waitForTranscript(env, opts);
        } catch (error) {
          emitAndExit(validationError(commandName(command), message(error)), ExitCode.InputValidation);
        }
      }),
  );
}

async function waitForTranscript(env: Envelope, opts: RunOpts): Promise<never> {
  const id = stringAt(env, ["transcription_id", "transcript_id", "id"]);
  if (!id) emitAndExit(validationError("elv stt", "--wait could not find a transcription id in the response"), ExitCode.InputValidation);
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
