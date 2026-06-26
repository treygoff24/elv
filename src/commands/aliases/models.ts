import type { Command } from "commander";
import { runAlias, type BuiltOperation } from "./shared";

export function buildModelsListInput(_flags: Record<string, never>): BuiltOperation {
  return { operationId: "get_models", input: {} };
}

export function registerModelsCommand(
  program: Command,
  addCommonFlags: (command: Command) => Command,
): void {
  addCommonFlags(
    program
      .command("models")
      .description("Models")
      .command("list")
      .description("List available models")
      .action((options: Record<string, never>, command: Command) =>
        runAlias(buildModelsListInput, options, command),
      ),
  );
}
