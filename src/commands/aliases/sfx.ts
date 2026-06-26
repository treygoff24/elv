import type { Command } from "commander";
import { runOperation } from "../../core/client";
import { emitAndExit, validationError } from "../../core/errors";
import { ExitCode } from "../../core/types";
import type { AgentInput } from "../../core/types";
import { commandName, compact, compactInput, emit, message, numberValue, required, runOpts } from "./shared";

export interface SfxFlags {
  prompt?: string;
  duration?: string | number;
  model?: string;
  format?: string;
  loop?: boolean;
}

export function buildSfxInput(flags: SfxFlags): { operationId: string; input: AgentInput } {
  return {
    operationId: "sound_generation",
    input: compactInput({
      query: compact({ output_format: flags.format }),
      body: compact({ text: required(flags.prompt, "--prompt"), duration_seconds: numberValue(flags.duration), model_id: flags.model, loop: flags.loop }),
    }),
  };
}

export function registerSfxCommand(program: Command, addCommonFlags: (command: Command) => Command): void {
  addCommonFlags(
    program
      .command("sfx")
      .description("Sound effects")
      .option("--prompt <text>", "sound effect description")
      .option("--duration <seconds>", "effect duration in seconds")
      .option("--model <id>", "sound effects model id")
      .option("--format <format>", "output audio format (output_format)")
      .option("--loop", "generate a seamlessly looping effect")
      .action(async (options: SfxFlags, command: Command) => runBuilt(options, command)),
  );
}

async function runBuilt(flags: SfxFlags, command: Command): Promise<never> {
  try {
    const built = buildSfxInput(flags);
    const env = await runOperation(built.operationId, built.input, runOpts(command));
    emit(env);
  } catch (error) {
    emitAndExit(validationError(commandName(command), message(error)), ExitCode.InputValidation);
  }
}
