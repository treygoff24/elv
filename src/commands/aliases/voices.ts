import { resolve } from "node:path";
import type { Command } from "commander";
import { runOperation } from "../../core/client";
import { emitAndExit, validationError } from "../../core/errors";
import { ExitCode } from "../../core/types";
import type { Envelope, RunOpts, SuccessEnvelope } from "../../core/types";
import {
  addPaginationFlags,
  type BuiltOperation,
  compact,
  compactInput,
  emit,
  required,
  runListAlias,
  aliasRunOpts,
  validationOrExit,
} from "./shared";

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

const RESOLVER_PAGE_SIZE = 100;

export interface VoiceRecord {
  name?: string;
  voice_id?: string;
  [key: string]: unknown;
}

type VoiceListData = {
  voices?: VoiceRecord[];
};

export function buildVoicesListInput(flags: VoicesFlags): BuiltOperation {
  return {
    operationId: "get_user_voices_v2",
    input: compactInput({ query: compact({ search: flags.search, sort: flags.sort }) }),
  };
}

export function buildVoicesFindInput(flags: VoicesFlags): BuiltOperation {
  return {
    operationId: "get_user_voices_v2",
    input: compactInput({ query: compact({ search: flags.query }) }),
  };
}

export function buildVoicesGetInput(flags: VoicesFlags): BuiltOperation {
  return {
    operationId: "get_voice_by_id",
    input: { path: { voice_id: required(flags.voiceId, "a voice id (positional or --voice-id)") } },
  };
}

export function buildVoicesCloneInstantInput(flags: VoicesFlags): BuiltOperation {
  return {
    operationId: "add_voice",
    input: compactInput({
      files: { files: [resolve(required(flags.file, "--file"))] },
      body: compact({
        name: required(flags.name, "--name"),
        remove_background_noise: flags.removeBackgroundNoise,
        description: flags.description,
      }),
    }),
  };
}

export function findMatchingVoices(query: string, voices: VoiceRecord[]): VoiceRecord[] {
  const needle = query.toLowerCase();
  const exact = voices.filter((voice) => String(voice.name ?? "").toLowerCase() === needle);
  if (exact.length) return exact;
  return voices.filter((voice) =>
    String(voice.name ?? "")
      .toLowerCase()
      .includes(needle),
  );
}

export async function resolveVoiceId(
  flags: { voiceId?: string; voice?: string },
  opts: RunOpts,
  cmd: string,
): Promise<string> {
  if (flags.voiceId) return flags.voiceId;
  if (!flags.voice)
    emitAndExit(
      validationError(cmd, "--voice-id or --voice is required"),
      ExitCode.InputValidation,
    );
  const env = await runOperation(
    "get_user_voices_v2",
    { query: { search: flags.voice } },
    { ...opts, inline: true, limit: RESOLVER_PAGE_SIZE },
  );
  if (!env.ok) emit(env);
  const voices = voicesFrom(env);
  const matches = findMatchingVoices(flags.voice, voices);
  if (matches.length === 1) return String(matches[0]?.voice_id);
  emitAndExit(
    validationError(
      cmd,
      matches.length === 0
        ? `No voice named "${flags.voice}"${candidateNames(flags.voice, voices)}`
        : `Ambiguous voice name "${flags.voice}"${candidateNames(flags.voice, voices)}`,
    ),
    ExitCode.InputValidation,
  );
}

function candidateNames(name: string, voices: VoiceRecord[]): string {
  const needle = name.toLowerCase();
  const names = voices
    .filter((voice) =>
      String(voice.name ?? "")
        .toLowerCase()
        .includes(needle),
    )
    .map((voice) => `${voice.name} (${voice.voice_id})`)
    .slice(0, 10);
  return names.length ? `; candidates: ${names.join(", ")}` : "";
}

function voicesFrom(env: Envelope): VoiceRecord[] {
  if (!env.ok) return [];
  const data = env.data as VoiceListData | undefined;
  return Array.isArray(data?.voices) ? data.voices : [];
}

export function registerVoicesCommand(
  program: Command,
  addCommonFlags: (command: Command) => Command,
): void {
  const voices = program.command("voices").description("Voices");
  addCommonFlags(
    addPaginationFlags(voices.command("list"))
      .description("List your voices")
      .option("--search <query>", "filter voices by name/labels")
      .option("--sort <field>", "sort field, e.g. created_at_unix or name")
      .action((options: VoicesFlags, command: Command) =>
        runListAlias(buildVoicesListInput, options, command),
      ),
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
        runListAlias(
          buildVoicesGetInput,
          { ...options, voiceId: voiceId ?? options.voiceId },
          command,
        ),
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
      .action((options: VoicesFlags, command: Command) =>
        runListAlias(buildVoicesCloneInstantInput, options, command),
      ),
  );
}

async function runFind(flags: VoicesFlags, command: Command): Promise<never> {
  const query = validationOrExit(command, () => required(flags.query, "query"));
  const built = buildVoicesFindInput(flags);
  const opts = validationOrExit(command, () => aliasRunOpts(command));
  const env = await runOperation(built.operationId, built.input, {
    ...opts,
    inline: true,
    limit: RESOLVER_PAGE_SIZE,
  });
  if (!env.ok) emit(env);
  const data = env.data as VoiceListData | undefined;
  const voices = Array.isArray(data?.voices) ? data.voices : [];
  // Emit only the matched voices — drop the upstream pagination fields
  // (has_more, next_page_token, next), which are noise for a name lookup.
  const matched = findMatchingVoices(query, voices);
  const result: SuccessEnvelope = { ...env, data: { voices: matched, count: matched.length } };
  emit(result);
}
