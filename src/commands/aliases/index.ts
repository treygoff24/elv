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

export {
  buildAgentsCreateInput,
  buildAgentsGetInput,
  buildAgentsListInput,
  buildAgentsSimulateInput,
  buildAgentsUpdateInput,
} from "./agents";
export {
  buildDubbingAudioInput,
  buildDubbingCreateInput,
  buildDubbingGetInput,
  buildDubbingListInput,
} from "./dubbing";
export { buildHistoryAudioInput, buildHistoryDeleteInput, buildHistoryListInput } from "./history";
export { buildModelsListInput } from "./models";
export { buildMusicInput } from "./music";
export { buildSfxInput } from "./sfx";
export { buildSttInput } from "./stt";
export { buildTtsInput } from "./tts";
export { buildUsageInput } from "./usage";
export { buildVoiceChangeInput } from "./voice-change";
export { buildVoiceIsolateInput } from "./voice-isolate";
export {
  buildVoicesCloneInstantInput,
  buildVoicesFindInput,
  buildVoicesGetInput,
  buildVoicesListInput,
  findMatchingVoices,
} from "./voices";

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
