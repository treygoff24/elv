import type { Command } from "commander";
import type { CliOptionValues } from "../options";
import { numberValue } from "../options";
import { runOperation } from "../../core/client";
import { emitAndExit, validationError } from "../../core/errors";
import { ExitCode } from "../../core/types";
import type { RunOpts, SuccessEnvelope } from "../../core/types";
import {
  addPaginationFlags,
  type BuiltOperation,
  compact,
  compactInput,
  emit,
  readJsonBody,
  required,
  requiredPath,
  runAlias,
  runListAlias,
  aliasRunOpts,
  validationOrExit,
  type JsonBodyFlags,
} from "./shared";

interface VoicesFlags extends Pick<
  CliOptionValues,
  "voiceId" | "search" | "sort" | "removeBackgroundNoise"
> {
  query?: string;
  name?: string;
  file?: string;
  description?: string;
}

interface VoiceListFlags extends VoicesFlags {
  gender?: string;
  age?: string;
  language?: string[];
  accent?: string;
  useCase?: string[];
  minNoticePeriodDays?: string | number;
  customRates?: boolean;
  liveModerated?: boolean;
  highQuality?: boolean;
}

interface VoiceAccentsFlags {
  language?: string;
  modelId?: string;
}

interface VoiceReplicationFlags extends JsonBodyFlags, Pick<CliOptionValues, "voiceId"> {
  targetWorkspaceId?: string;
  preserveVoiceId?: boolean;
}

const RESOLVER_PAGE_SIZE = 100;

interface VoiceRecord {
  name: string;
  voice_id: string;
}

export type VoiceSelector = Pick<CliOptionValues, "voiceId" | "voice">;

type VoiceListData = {
  voices: VoiceRecord[];
};

export function buildVoicesListInput(flags: VoiceListFlags): BuiltOperation {
  return {
    operationId: "get_user_voices_v2",
    input: compactInput({
      query: compact({
        search: flags.search,
        sort: flags.sort,
        gender: flags.gender,
        age: flags.age,
        language: flags.language,
        accent: flags.accent,
        use_cases: flags.useCase,
        min_notice_period_days: numberValue(flags.minNoticePeriodDays),
        include_custom_rates: flags.customRates === false ? false : undefined,
        include_live_moderated: flags.liveModerated === false ? false : undefined,
        high_quality: flags.highQuality ? true : undefined,
      }),
    }),
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
      files: { files: [requiredPath(flags.file, "--file")] },
      body: compact({
        name: required(flags.name, "--name"),
        remove_background_noise: flags.removeBackgroundNoise,
        description: flags.description,
      }),
    }),
  };
}

export function buildVoiceAccentsInput(flags: VoiceAccentsFlags): BuiltOperation {
  return {
    operationId: "get_voice_accents",
    input: compactInput({ query: compact({ language: flags.language, model_id: flags.modelId }) }),
  };
}

export function buildVoiceReplicationInput(flags: VoiceReplicationFlags): BuiltOperation {
  const body = readJsonBody(flags, false);
  if (flags.targetWorkspaceId !== undefined) body.target_workspace_id = flags.targetWorkspaceId;
  if (body.target_workspace_id === undefined)
    throw new Error("--target-workspace-id or JSON target_workspace_id is required");
  if (flags.preserveVoiceId === false) body.preserve_voice_id = false;
  return {
    operationId: "replicate_voice_to_isolated_environment",
    input: {
      path: { voice_id: required(flags.voiceId, "--voice-id") },
      body,
    },
  };
}

export function findMatchingVoices(query: string, voices: VoiceRecord[]): VoiceRecord[] {
  const needle = query.toLowerCase();
  const exact = voices.filter((voice) => voice.name.toLowerCase() === needle);
  if (exact.length) return exact;
  return voices.filter((voice) => voice.name.toLowerCase().includes(needle));
}

export async function resolveVoiceId(
  flags: VoiceSelector,
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
  if (matches.length === 1) return matches[0]!.voice_id;
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
    .filter((voice) => voice.name.toLowerCase().includes(needle))
    .map((voice) => `${voice.name} (${voice.voice_id})`)
    .slice(0, 10);
  return names.length ? `; candidates: ${names.join(", ")}` : "";
}

function voicesFrom(env: SuccessEnvelope): VoiceRecord[] {
  return (env.data as VoiceListData).voices;
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
      .option("--gender <gender>", "filter by the voice gender label")
      .option("--age <age>", "filter by the voice age label")
      .option("--language <code...>", "filter by any language code")
      .option("--accent <accent>", "filter by the voice accent label")
      .option("--use-case <use-case...>", "filter by any use-case label")
      .option("--min-notice-period-days <days>", "minimum sharing notice period in days")
      .option("--no-custom-rates", "exclude voices with custom sharing rates")
      .option("--no-live-moderated", "exclude voices with live moderation")
      .option("--high-quality", "only return studio-quality voices")
      .action((options: VoiceListFlags, command: Command) =>
        runListAlias(buildVoicesListInput, options, command),
      ),
  );
  addCommonFlags(
    voices
      .command("accents")
      .description("List available voice accents")
      .option("--language <code>", "filter by language code")
      .option("--model-id <id>", "filter by model id")
      .action((options: VoiceAccentsFlags, command: Command) =>
        runAlias(buildVoiceAccentsInput, options, command),
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
  addCommonFlags(
    voices
      .command("replicate")
      .description("Replicate a voice into an isolated workspace")
      .option("--voice-id <id>", "voice id to replicate")
      .option("--target-workspace-id <id>", "target workspace id")
      .option("--no-preserve-voice-id", "assign a new voice id in the target workspace")
      .option("--json <json>", "replication request JSON")
      .option("--json-file <path>", "replication request JSON file")
      .action((options: VoiceReplicationFlags, command: Command) =>
        runAlias(buildVoiceReplicationInput, options, command),
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
  const matched = findMatchingVoices(query, voicesFrom(env));
  const result: SuccessEnvelope = { ...env, data: { voices: matched, count: matched.length } };
  emit(result);
}
