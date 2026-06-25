import { resolve } from "node:path";
import type { Command } from "commander";
import { runOperation } from "../../core/client";
import { emitAndExit, validationError } from "../../core/errors";
import { ExitCode } from "../../core/types";
import type { AgentInput } from "../../core/types";
import { commandName, compact, compactInput, emit, message, required, runOpts } from "./shared";

export interface VoiceIsolateFlags {
  file?: string;
  fileFormat?: string;
  previewB64?: string;
}

export function buildVoiceIsolateInput(flags: VoiceIsolateFlags): { operationId: string; input: AgentInput } {
  return {
    operationId: "audio_isolation",
    input: compactInput({
      files: { audio: resolve(required(flags.file, "--file")) },
      body: compact({ file_format: flags.fileFormat, preview_b64: flags.previewB64 }),
    }),
  };
}

export function registerVoiceIsolateCommand(program: Command, addCommonFlags: (command: Command) => Command): void {
  addCommonFlags(
    program
      .command("voice-isolate")
      .description("Audio isolation")
      .option("--file <path>")
      .option("--file-format <format>")
      .option("--preview-b64 <value>")
      .action(async (options: VoiceIsolateFlags, command: Command) => runBuilt(options, command)),
  );
}

async function runBuilt(flags: VoiceIsolateFlags, command: Command): Promise<never> {
  try {
    const built = buildVoiceIsolateInput(flags);
    const env = await runOperation(built.operationId, built.input, runOpts(command));
    emit(env);
  } catch (error) {
    emitAndExit(validationError(commandName(command), message(error)), ExitCode.InputValidation);
  }
}
