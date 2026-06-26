import type { Command } from "commander";
import { runOperation } from "../../core/client";
import { emitAndExit, validationError } from "../../core/errors";
import { ExitCode } from "../../core/types";
import type { AgentInput } from "../../core/types";
import { commandName, compact, compactInput, emit, message, numberValue, required, runOpts } from "./shared";

export interface HistoryFlags {
  id?: string;
  limit?: string | number;
}

export function buildHistoryListInput(flags: HistoryFlags): { operationId: string; input: AgentInput } {
  return { operationId: "get_speech_history", input: compactInput({ query: compact({ page_size: numberValue(flags.limit) }) }) };
}

export function buildHistoryAudioInput(flags: HistoryFlags): { operationId: string; input: AgentInput } {
  return { operationId: "get_audio_full_from_speech_history_item", input: { path: { history_item_id: required(flags.id, "--id") } } };
}

export function buildHistoryDeleteInput(flags: HistoryFlags): { operationId: string; input: AgentInput } {
  return { operationId: "delete_speech_history_item", input: { path: { history_item_id: required(flags.id, "--id") } } };
}

export function registerHistoryCommand(program: Command, addCommonFlags: (command: Command) => Command): void {
  const history = program.command("history").description("Speech history");
  addCommonFlags(history.command("list").option("--limit <n>", "max history items per page (page_size)").action((options: HistoryFlags, command: Command) => runBuilt(buildHistoryListInput, options, command)));
  addCommonFlags(history.command("audio").option("--id <id>", "speech history item id").action((options: HistoryFlags, command: Command) => runBuilt(buildHistoryAudioInput, options, command)));
  addCommonFlags(history.command("delete").option("--id <id>", "speech history item id").action((options: HistoryFlags, command: Command) => runBuilt(buildHistoryDeleteInput, options, command)));
}

async function runBuilt<T>(builder: (flags: T) => { operationId: string; input: AgentInput }, flags: T, command: Command): Promise<never> {
  try {
    const built = builder(flags);
    const env = await runOperation(built.operationId, built.input, runOpts(command));
    emit(env);
  } catch (error) {
    emitAndExit(validationError(commandName(command), message(error)), ExitCode.InputValidation);
  }
}
