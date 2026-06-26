import type { Command } from "commander";
import type { AgentInput } from "../../core/types";
import { runAlias } from "./shared";

export function buildModelsListInput(_flags: Record<string, never>): {
  operationId: string;
  input: AgentInput;
} {
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
      .action((options: Record<string, never>, command: Command) => runBuilt(options, command)),
  );
}

async function runBuilt(flags: Record<string, never>, command: Command): Promise<never> {
  return runAlias(buildModelsListInput, flags, command);
}
