import type { Command } from "commander";
import type { AgentInput } from "../../core/types";
import { addPaginationFlags, required, runListAlias } from "./shared";

export interface HistoryFlags {
  id?: string;
}

export function buildHistoryListInput(_flags: HistoryFlags): {
  operationId: string;
  input: AgentInput;
} {
  return { operationId: "get_speech_history", input: {} };
}

export function buildHistoryAudioInput(flags: HistoryFlags): {
  operationId: string;
  input: AgentInput;
} {
  return {
    operationId: "get_audio_full_from_speech_history_item",
    input: { path: { history_item_id: required(flags.id, "--id") } },
  };
}

export function buildHistoryDeleteInput(flags: HistoryFlags): {
  operationId: string;
  input: AgentInput;
} {
  return {
    operationId: "delete_speech_history_item",
    input: { path: { history_item_id: required(flags.id, "--id") } },
  };
}

export function registerHistoryCommand(
  program: Command,
  addCommonFlags: (command: Command) => Command,
): void {
  const history = program.command("history").description("Speech history");
  addCommonFlags(
    addPaginationFlags(history.command("list"))
      .description("List speech history")
      .action((options: HistoryFlags, command: Command) =>
        runBuilt(buildHistoryListInput, options, command),
      ),
  );
  addCommonFlags(
    history
      .command("audio")
      .description("Download a history item's audio")
      .option("--id <id>", "speech history item id")
      .action((options: HistoryFlags, command: Command) =>
        runBuilt(buildHistoryAudioInput, options, command),
      ),
  );
  addCommonFlags(
    history
      .command("delete")
      .description("Delete a speech history item")
      .option("--id <id>", "speech history item id")
      .action((options: HistoryFlags, command: Command) =>
        runBuilt(buildHistoryDeleteInput, options, command),
      ),
  );
}

async function runBuilt<T>(
  builder: (flags: T) => { operationId: string; input: AgentInput },
  flags: T,
  command: Command,
): Promise<never> {
  return runListAlias(builder, flags, command);
}
