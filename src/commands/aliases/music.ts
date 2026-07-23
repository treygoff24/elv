import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { collect, mergedOptions, numberValue } from "../options";
import {
  addPaginationFlags,
  compact,
  compactInput,
  readJsonBody,
  required,
  requiredPath,
  runAlias,
  runListAlias,
  type BuiltOperation,
  type JsonBodyFlags,
} from "./shared";

interface MusicFlags {
  prompt?: string;
  promptFile?: string;
  model?: string;
  format?: string;
  lengthMs?: string | number;
  stream?: boolean;
  detailed?: boolean;
  timestamps?: boolean;
  finetuneId?: string;
}

interface MusicFinetuneListFlags {
  visibility?: string;
  createdBy?: string;
  sort?: string;
  sortDirection?: string;
}

interface MusicFinetuneFlags extends JsonBodyFlags {
  finetuneId?: string;
  name?: string;
  primaryGenre?: string;
  file?: string[];
  tag?: string[];
  visibility?: string;
  model?: string;
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
        finetune_id: flags.finetuneId,
      }),
    }),
  };
}

export function buildMusicFinetunesListInput(flags: MusicFinetuneListFlags): BuiltOperation {
  return {
    operationId: "get_finetunes",
    input: compactInput({
      query: compact({
        visibility: flags.visibility,
        created_by: flags.createdBy,
        sort: flags.sort,
        sort_direction: flags.sortDirection,
      }),
    }),
  };
}

export function buildMusicFinetuneGetInput(flags: MusicFinetuneFlags): BuiltOperation {
  return {
    operationId: "get_finetune",
    input: { path: { finetune_id: required(flags.finetuneId, "--finetune-id") } },
  };
}

export function buildMusicFinetuneCreateInput(flags: MusicFinetuneFlags): BuiltOperation {
  if (!flags.file?.length) throw new Error("--file is required");
  return {
    operationId: "create_finetune",
    input: {
      files: { files: flags.file.map((file) => requiredPath(file, "--file")) },
      body: compact({
        name: required(flags.name, "--name"),
        primary_genre: required(flags.primaryGenre, "--primary-genre"),
        tags: flags.tag?.length ? flags.tag : undefined,
        visibility: flags.visibility,
        model_id: flags.model,
      }),
    },
  };
}

export function buildMusicFinetuneUpdateInput(flags: MusicFinetuneFlags): BuiltOperation {
  return {
    operationId: "update_finetune",
    input: {
      path: { finetune_id: required(flags.finetuneId, "--finetune-id") },
      body: readJsonBody(flags),
    },
  };
}

export function buildMusicFinetuneDeleteInput(flags: MusicFinetuneFlags): BuiltOperation {
  return {
    operationId: "delete_finetune",
    input: { path: { finetune_id: required(flags.finetuneId, "--finetune-id") } },
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
        .option("--finetune-id <id>", "Music Finetune id")
        .action(async (_options: MusicFlags, command: Command) =>
          runAlias(buildMusicInput, { ...(mergedOptions(command) as MusicFlags), stream }, command),
        ),
    );
  configure(music, false);
  configure(music.command("stream").description("Music generation (streaming)"), true);
  addCommonFlags(
    music
      .command("detailed-stream")
      .description("Stream Music audio and detailed metadata as SSE")
      .option("--prompt <text>", "music generation prompt")
      .option("--prompt-file <path>", "read prompt from a file")
      .option("--model <id>", "music model id")
      .option("--format <format>", "output audio format (output_format)")
      .option("--length-ms <ms>", "target track length in milliseconds")
      .option("--finetune-id <id>", "Music Finetune id")
      .option("--timestamps", "include word timestamps")
      .action((_options: MusicFlags, command: Command) =>
        runAlias(
          buildMusicInput,
          { ...(mergedOptions(command) as MusicFlags), detailed: true },
          command,
        ),
      ),
  );

  const finetunes = music.command("finetunes").description("Music Finetunes");
  addCommonFlags(
    addPaginationFlags(finetunes.command("list"))
      .description("List accessible Music Finetunes")
      .option("--visibility <visibility>", "filter by private, workspace, or public visibility")
      .option("--created-by <creator>", "filter by self, workspace, or elevenlabs")
      .option("--sort <field>", "sort by created_at or name")
      .option("--sort-direction <direction>", "sort direction: asc or desc")
      .action((options: MusicFinetuneListFlags, command: Command) =>
        runListAlias(buildMusicFinetunesListInput, options, command),
      ),
  );
  addCommonFlags(
    finetunes
      .command("get")
      .description("Get a Music Finetune")
      .option("--finetune-id <id>", "Music Finetune id")
      .action((_options: MusicFinetuneFlags, command: Command) =>
        runAlias(buildMusicFinetuneGetInput, mergedOptions(command) as MusicFinetuneFlags, command),
      ),
  );
  addCommonFlags(
    finetunes
      .command("create")
      .description("Create and train a Music Finetune")
      .option("--name <name>", "Music Finetune name")
      .option("--primary-genre <genre>", "primary musical genre")
      .option("--file <path>", "training audio file (repeatable, up to 50)", collect, [])
      .option("--tag <tag>", "tag (repeatable)", collect, [])
      .option("--visibility <visibility>", "private or workspace")
      .option("--model <id>", "base music model id")
      .action((_options: MusicFinetuneFlags, command: Command) =>
        runAlias(
          buildMusicFinetuneCreateInput,
          mergedOptions(command) as MusicFinetuneFlags,
          command,
        ),
      ),
  );
  addCommonFlags(
    finetunes
      .command("update")
      .description("Update Music Finetune metadata")
      .option("--finetune-id <id>", "Music Finetune id")
      .option("--json <json>", "updated fields as JSON")
      .option("--json-file <path>", "updated fields JSON file")
      .action((_options: MusicFinetuneFlags, command: Command) =>
        runAlias(
          buildMusicFinetuneUpdateInput,
          mergedOptions(command) as MusicFinetuneFlags,
          command,
        ),
      ),
  );
  addCommonFlags(
    finetunes
      .command("delete")
      .description("Delete a Music Finetune (requires --yes)")
      .option("--finetune-id <id>", "Music Finetune id")
      .action((_options: MusicFinetuneFlags, command: Command) =>
        runAlias(
          buildMusicFinetuneDeleteInput,
          mergedOptions(command) as MusicFinetuneFlags,
          command,
        ),
      ),
  );
}

function readPrompt(prompt: string | undefined, file: string | undefined): string | undefined {
  if (prompt !== undefined && file !== undefined)
    throw new Error("Use --prompt or --prompt-file, not both");
  if (prompt !== undefined) return prompt;
  if (file !== undefined) return readFileSync(file, "utf8");
  return undefined;
}
