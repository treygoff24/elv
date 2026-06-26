import type { Command } from "commander";
import { runOperation } from "../../core/client";
import { emitAndExit, validationError } from "../../core/errors";
import { ExitCode } from "../../core/types";
import type { AgentInput } from "../../core/types";
import { commandName, emit, message, runOpts } from "./shared";

export function buildModelsListInput(_flags: Record<string, never>): { operationId: string; input: AgentInput } {
  return { operationId: "get_models", input: {} };
}

export function registerModelsCommand(program: Command, addCommonFlags: (command: Command) => Command): void {
  addCommonFlags(program.command("models").description("Models").command("list").description("List available models").action((options: Record<string, never>, command: Command) => runBuilt(options, command)));
}

async function runBuilt(flags: Record<string, never>, command: Command): Promise<never> {
  try {
    const built = buildModelsListInput(flags);
    const env = await runOperation(built.operationId, built.input, runOpts(command));
    emit(env);
  } catch (error) {
    emitAndExit(validationError(commandName(command), message(error)), ExitCode.InputValidation);
  }
}
