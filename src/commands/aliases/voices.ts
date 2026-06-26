import { resolve } from "node:path";
import type { Command } from "commander";
import { runOperation } from "../../core/client";
import { emitAndExit, validationError } from "../../core/errors";
import { ExitCode } from "../../core/types";
import type { AgentInput, SuccessEnvelope } from "../../core/types";
import { addPaginationFlags, commandName, compact, compactInput, emit, message, projectFields, required, resolveListOpts, runOpts } from "./shared";

export interface VoicesFlags {
  query?: string;
  search?: string;
  sort?: string;
  voiceId?: string;
  name?: string;
  file?: string;
  removeBackgroundNoise?: boolean;
  description?: string;
}

export const RESOLVER_PAGE_SIZE = 100;

export interface VoiceRecord {
  name?: unknown;
  voice_id?: unknown;
  [key: string]: unknown;
}

export function buildVoicesListInput(flags: VoicesFlags): { operationId: string; input: AgentInput } {
  return {
    operationId: "get_user_voices_v2",
    input: compactInput({ query: compact({ search: flags.search, sort: flags.sort }) }),
  };
}

export function buildVoicesFindInput(flags: VoicesFlags): { operationId: string; input: AgentInput } {
  return {
    operationId: "get_user_voices_v2",
    input: compactInput({ query: compact({ search: flags.query }) }),
  };
}

export function buildVoicesGetInput(flags: VoicesFlags): { operationId: string; input: AgentInput } {
  return { operationId: "get_voice_by_id", input: { path: { voice_id: required(flags.voiceId, "a voice id (positional or --voice-id)") } } };
}

export function buildVoicesCloneInstantInput(flags: VoicesFlags): { operationId: string; input: AgentInput } {
  return {
    operationId: "add_voice",
    input: compactInput({
      files: { files: [resolve(required(flags.file, "--file"))] },
      body: compact({ name: required(flags.name, "--name"), remove_background_noise: flags.removeBackgroundNoise, description: flags.description }),
    }),
  };
}

export function findMatchingVoices(query: string, voices: VoiceRecord[]): VoiceRecord[] {
  const needle = query.toLowerCase();
  const exact = voices.filter((voice) => String(voice.name ?? "").toLowerCase() === needle);
  if (exact.length) return exact;
  return voices.filter((voice) => String(voice.name ?? "").toLowerCase().includes(needle));
}

export function registerVoicesCommand(program: Command, addCommonFlags: (command: Command) => Command): void {
  const voices = program.command("voices").description("Voices");
  addCommonFlags(
    addPaginationFlags(voices.command("list"))
      .description("List your voices")
      .option("--search <query>", "filter voices by name/labels")
      .option("--sort <field>", "sort field, e.g. created_at_unix or name")
      .action((options: VoicesFlags, command: Command) => runBuilt(buildVoicesListInput, options, command)),
  );
  addCommonFlags(
    voices
      .command("find <query>")
      .description("Find voices by name (exact, else substring)")
      .action(async (query: string, options: VoicesFlags, command: Command) => {
        const opts = { ...options, query };
        await runFind(opts, command);
      }),
  );
  addCommonFlags(
    voices
      .command("get [voice_id]")
      .description("Get a voice by id (positional or --voice-id)")
      .option("--voice-id <id>", "ElevenLabs voice id (alternative to the positional argument)")
      .action((voiceId: string | undefined, options: VoicesFlags, command: Command) =>
        runBuilt(buildVoicesGetInput, { ...options, voiceId: voiceId ?? options.voiceId }, command),
      ),
  );
  addCommonFlags(
    voices
      .command("clone-instant")
      .description("Instant-clone a voice from an audio sample")
      .option("--name <name>", "name for the cloned voice")
      .option("--file <path>", "sample audio file for instant cloning")
      .option("--remove-background-noise", "remove background noise from the sample")
      .option("--description <text>", "optional voice description")
      .action((options: VoicesFlags, command: Command) => runBuilt(buildVoicesCloneInstantInput, options, command)),
  );
}

async function runFind(flags: VoicesFlags, command: Command): Promise<never> {
  try {
    const built = buildVoicesFindInput(flags);
    const env = await runOperation(built.operationId, built.input, { ...runOpts(command), inline: true, limit: RESOLVER_PAGE_SIZE });
    if (!env.ok) emit(env);
    const data = env.data as { voices?: unknown } | undefined;
    const voices = Array.isArray(data?.voices) ? (data.voices as VoiceRecord[]) : [];
    // Emit only the matched voices — drop the upstream pagination fields
    // (has_more, next_page_token, next), which are noise for a name lookup.
    const matched = findMatchingVoices(required(flags.query, "query"), voices);
    const result: SuccessEnvelope = { ...env, data: { voices: matched, count: matched.length } };
    emit(result);
  } catch (error) {
    emitAndExit(validationError(commandName(command), message(error)), ExitCode.InputValidation);
  }
}

async function runBuilt<T>(builder: (flags: T) => { operationId: string; input: AgentInput }, flags: T, command: Command): Promise<never> {
  try {
    const built = builder(flags);
    const { fields, fetch } = resolveListOpts(command);
    const env = await runOperation(built.operationId, built.input, { ...runOpts(command), ...fetch });
    emit(fields && env.ok ? projectFields(env, fields) : env);
  } catch (error) {
    emitAndExit(validationError(commandName(command), message(error)), ExitCode.InputValidation);
  }
}
