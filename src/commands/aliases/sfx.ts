import type { Command } from "commander";
import { numberValue, type CliOptionValues } from "../options";
import { compact, compactInput, required, runAlias, type BuiltOperation } from "./shared";

interface SfxFlags extends Pick<CliOptionValues, "model" | "format"> {
  prompt?: string;
  duration?: string | number;
  loop?: boolean;
}

export function buildSfxInput(flags: SfxFlags): BuiltOperation {
  return {
    operationId: "sound_generation",
    input: compactInput({
      query: compact({ output_format: flags.format }),
      body: compact({
        text: required(flags.prompt, "--prompt"),
        duration_seconds: numberValue(flags.duration),
        model_id: flags.model,
        loop: flags.loop,
      }),
    }),
  };
}

export function registerSfxCommand(
  program: Command,
  addCommonFlags: (command: Command) => Command,
): void {
  addCommonFlags(
    program
      .command("sfx")
      .description("Sound effects")
      .option("--prompt <text>", "sound effect description")
      .option("--duration <seconds>", "effect duration in seconds")
      .option("--model <id>", "sound effects model id")
      .option("--format <format>", "output audio format (output_format)")
      .option("--loop", "generate a seamlessly looping effect")
      .action(async (options: SfxFlags, command: Command) =>
        runAlias(buildSfxInput, options, command),
      ),
  );
}
