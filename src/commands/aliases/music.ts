import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { mergedOptions, numberValue, type CliOptionValues } from "../options";
import { compact, compactInput, runAlias, type BuiltOperation } from "./shared";

interface MusicFlags extends Pick<CliOptionValues, "model" | "format" | "timestamps"> {
  prompt?: string;
  promptFile?: string;
  lengthMs?: string | number;
  stream?: boolean;
  detailed?: boolean;
}

export function buildMusicInput(flags: MusicFlags): BuiltOperation {
  return {
    operationId: flags.detailed
      ? "compose_detailed_stream"
      : flags.stream
        ? "stream_compose"
        : "generate",
    input: compactInput({
      query: compact({ output_format: flags.format }),
      body: compact({
        prompt: readPrompt(flags.prompt, flags.promptFile),
        model_id: flags.model,
        music_length_ms: numberValue(flags.lengthMs),
        with_timestamps: flags.detailed && flags.timestamps ? true : undefined,
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
      addMusicOptions(command).action(async (_options: MusicFlags, command: Command) =>
        runAlias(buildMusicInput, { ...(mergedOptions(command) as MusicFlags), stream }, command),
      ),
    );
  configure(music, false);
  configure(music.command("stream").description("Music generation (streaming)"), true);
  addCommonFlags(
    addMusicOptions(
      music
        .command("detailed-stream")
        .description("Stream Music audio and detailed metadata as SSE"),
    )
      .option("--timestamps", "include word timestamps")
      .action((_options: MusicFlags, command: Command) =>
        runAlias(
          buildMusicInput,
          { ...(mergedOptions(command) as MusicFlags), detailed: true },
          command,
        ),
      ),
  );
}

function addMusicOptions(command: Command): Command {
  return command
    .option("--prompt <text>", "music generation prompt")
    .option("--prompt-file <path>", "read prompt from a file")
    .option("--model <id>", "music model id")
    .option("--format <format>", "output audio format (output_format)")
    .option("--length-ms <ms>", "target track length in milliseconds");
}

function readPrompt(prompt: string | undefined, file: string | undefined): string | undefined {
  if (prompt !== undefined && file !== undefined)
    throw new Error("Use --prompt or --prompt-file, not both");
  if (prompt !== undefined) return prompt;
  if (file !== undefined) return readFileSync(file, "utf8");
  return undefined;
}
