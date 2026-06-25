import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { runOperation } from "../../core/client";
import { emitAndExit, exitCodeForError, validationError } from "../../core/errors";
import { ExitCode } from "../../core/types";
import type { AgentInput, Envelope, RunOpts } from "../../core/types";

export interface MusicFlags {
  prompt?: string;
  promptFile?: string;
  model?: string;
  format?: string;
  lengthMs?: string | number;
  stream?: boolean;
}

export function buildMusicInput(flags: MusicFlags): { operationId: string; input: AgentInput } {
  return {
    operationId: flags.stream ? "stream_compose" : "generate",
    input: compactInput({
      query: compact({ output_format: flags.format }),
      body: compact({ prompt: readPrompt(flags.prompt, flags.promptFile), model_id: flags.model, music_length_ms: numberValue(flags.lengthMs) }),
    }),
  };
}

export function registerMusicCommand(program: Command, addCommonFlags: (command: Command) => Command): void {
  const music = program.command("music").description("Music generation");
  const configure = (command: Command, stream: boolean) =>
    addCommonFlags(
      command
        .option("--prompt <text>")
        .option("--prompt-file <path>")
        .option("--model <id>")
        .option("--format <format>")
        .option("--length-ms <ms>")
        .action(async (options: MusicFlags, command: Command) => runBuilt({ ...options, stream }, command)),
    );
  configure(music, false);
  configure(music.command("stream"), true);
}

async function runBuilt(flags: MusicFlags, command: Command): Promise<never> {
  try {
    const built = buildMusicInput(flags);
    const env = await runOperation(built.operationId, built.input, runOpts(command));
    emit(env);
  } catch (error) {
    emitAndExit(validationError(commandName(command), message(error)), ExitCode.InputValidation);
  }
}

function readPrompt(prompt: string | undefined, file: string | undefined): string | undefined {
  if (prompt !== undefined && file !== undefined) throw new Error("Use --prompt or --prompt-file, not both");
  if (prompt !== undefined) return prompt;
  if (file !== undefined) return readFileSync(file, "utf8");
  return undefined;
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
