import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { runOperation } from "../../core/client";
import { emitAndExit, validationError } from "../../core/errors";
import { ExitCode } from "../../core/types";
import type { AgentInput } from "../../core/types";
import { commandName, compact, compactInput, emit, message, numberValue, runOpts } from "./shared";

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
      body: compact({
        prompt: readPrompt(flags.prompt, flags.promptFile),
        model_id: flags.model,
        music_length_ms: numberValue(flags.lengthMs),
      }),
    }),
  };
}

export function registerMusicCommand(
  program: Command,
  addCommonFlags: (command: Command) => Command,
): void {
  const music = program.command("music").description("Music generation");
  const configure = (command: Command, stream: boolean) =>
    addCommonFlags(
      command
        .option("--prompt <text>", "music generation prompt")
        .option("--prompt-file <path>", "read prompt from a file")
        .option("--model <id>", "music model id")
        .option("--format <format>", "output audio format (output_format)")
        .option("--length-ms <ms>", "target track length in milliseconds")
        .action(async (options: MusicFlags, command: Command) =>
          runBuilt({ ...options, stream }, command),
        ),
    );
  configure(music, false);
  configure(music.command("stream").description("Music generation (streaming)"), true);
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
  if (prompt !== undefined && file !== undefined)
    throw new Error("Use --prompt or --prompt-file, not both");
  if (prompt !== undefined) return prompt;
  if (file !== undefined) return readFileSync(file, "utf8");
  return undefined;
}
