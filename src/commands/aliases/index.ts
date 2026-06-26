import type { Command } from "commander";
import { registerAgentsCommand } from "./agents";
import { registerDubbingCommand } from "./dubbing";
import { registerHistoryCommand } from "./history";
import { registerModelsCommand } from "./models";
import { registerMusicCommand } from "./music";
import { registerSfxCommand } from "./sfx";
import { registerSttCommand } from "./stt";
import { registerTtsCommand } from "./tts";
import { registerUsageCommand } from "./usage";
import { registerVoiceChangeCommand } from "./voice-change";
import { registerVoiceIsolateCommand } from "./voice-isolate";
import { registerVoicesCommand } from "./voices";

export function registerAliases(
  program: Command,
  addCommonFlags: (command: Command) => Command,
): void {
  registerTtsCommand(program, addCommonFlags);
  registerSttCommand(program, addCommonFlags);
  registerMusicCommand(program, addCommonFlags);
  registerSfxCommand(program, addCommonFlags);
  registerVoiceChangeCommand(program, addCommonFlags);
  registerVoiceIsolateCommand(program, addCommonFlags);
  registerDubbingCommand(program, addCommonFlags);
  registerVoicesCommand(program, addCommonFlags);
  registerAgentsCommand(program, addCommonFlags);
  registerModelsCommand(program, addCommonFlags);
  registerHistoryCommand(program, addCommonFlags);
  registerUsageCommand(program, addCommonFlags);
}
