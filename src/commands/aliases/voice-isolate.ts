import { resolve } from "node:path";
import type { Command } from "commander";
import type { AgentInput } from "../../core/types";
import { compact, compactInput, required, runAlias } from "./shared";

export interface VoiceIsolateFlags {
  file?: string;
  fileFormat?: string;
  previewB64?: string;
}

export function buildVoiceIsolateInput(flags: VoiceIsolateFlags): {
  operationId: string;
  input: AgentInput;
} {
  return {
    operationId: "audio_isolation",
    input: compactInput({
      files: { audio: resolve(required(flags.file, "--file")) },
      body: compact({ file_format: flags.fileFormat, preview_b64: flags.previewB64 }),
    }),
  };
}

export function registerVoiceIsolateCommand(
  program: Command,
  addCommonFlags: (command: Command) => Command,
): void {
  addCommonFlags(
    program
      .command("voice-isolate")
      .description("Audio isolation")
      .option("--file <path>", "input audio file to isolate")
      .option("--file-format <format>", "input file format hint for the API")
      .option("--preview-b64 <value>", "base64 preview snippet for the request body")
      .action(async (options: VoiceIsolateFlags, command: Command) =>
        runAlias(buildVoiceIsolateInput, options, command),
      ),
  );
}
