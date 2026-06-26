import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildAgentsCreateInput,
  buildAgentsGetInput,
  buildAgentsListInput,
  buildAgentsSimulateInput,
  buildAgentsUpdateInput,
  buildDubbingAudioInput,
  buildDubbingCreateInput,
  buildDubbingGetInput,
  buildDubbingListInput,
  buildHistoryAudioInput,
  buildHistoryDeleteInput,
  buildHistoryListInput,
  buildModelsListInput,
  buildMusicInput,
  buildSfxInput,
  buildSttInput,
  buildTtsInput,
  buildUsageInput,
  buildVoiceChangeInput,
  buildVoiceIsolateInput,
  buildVoicesCloneInstantInput,
  buildVoicesFindInput,
  buildVoicesGetInput,
  buildVoicesListInput,
  findMatchingVoices,
} from "../../src/commands/aliases";
import { buildHttpRequest, normalizeInput } from "../../src/core/request-builder";
import { loadRegistry } from "../../src/openapi/registry";
import type { BuiltOperation } from "../../src/commands/aliases/shared";
import type { AgentInput } from "../../src/core/types";
import type { OperationCard } from "../../src/openapi/types";

let dir: string;
let audio: string;
let video: string;
let agentJson: string;
let registry: Promise<Map<string, OperationCard>>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "elv-aliases-"));
  audio = join(dir, "audio.wav");
  video = join(dir, "video.mp4");
  agentJson = join(dir, "agent.json");
  writeFileSync(audio, "audio");
  writeFileSync(video, "video");
  writeFileSync(agentJson, JSON.stringify({ conversation_config: {}, name: "Agent" }));
  registry = loadRegistry({ cacheDir: join(dir, "cache"), forceRecompile: true });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const cases: Array<{ name: string; alias: () => BuiltOperation; call: () => BuiltOperation }> = [
  {
    name: "tts",
    alias: () =>
      buildTtsInput({
        voiceId: "voice_1",
        text: "Hello.",
        model: "eleven_v3",
        format: "mp3_44100_128",
      }),
    call: () => ({
      operationId: "text_to_speech_full",
      input: {
        path: { voice_id: "voice_1" },
        query: { output_format: "mp3_44100_128" },
        body: { text: "Hello.", model_id: "eleven_v3" },
      },
    }),
  },
  {
    name: "tts stream timestamps",
    alias: () =>
      buildTtsInput({
        stream: true,
        timestamps: true,
        voiceId: "voice_1",
        textFile: join(dir, "script.txt"),
      }),
    call: () => ({
      operationId: "text_to_speech_stream_with_timestamps",
      input: { path: { voice_id: "voice_1" }, body: { text: "From file" } },
    }),
  },
  {
    name: "stt",
    alias: () =>
      buildSttInput({
        file: audio,
        model: "scribe_v2",
        timestamps: "word",
        diarize: true,
        language: "en",
        webhook: "https://example.test/hook",
      }),
    call: () => ({
      operationId: "speech_to_text",
      input: {
        files: { file: resolve(audio) },
        body: {
          model_id: "scribe_v2",
          timestamps_granularity: "word",
          diarize: true,
          language_code: "en",
          webhook: "https://example.test/hook",
        },
      },
    }),
  },
  {
    name: "music",
    alias: () =>
      buildMusicInput({ prompt: "30s lo-fi loop", model: "music_v2", format: "mp3_44100_128" }),
    call: () => ({
      operationId: "generate",
      input: {
        query: { output_format: "mp3_44100_128" },
        body: { prompt: "30s lo-fi loop", model_id: "music_v2" },
      },
    }),
  },
  {
    name: "music stream",
    alias: () => buildMusicInput({ stream: true, prompt: "30s lo-fi loop" }),
    call: () => ({ operationId: "stream_compose", input: { body: { prompt: "30s lo-fi loop" } } }),
  },
  {
    name: "sfx",
    alias: () => buildSfxInput({ prompt: "Door creak", duration: "3", format: "mp3_44100_128" }),
    call: () => ({
      operationId: "sound_generation",
      input: {
        query: { output_format: "mp3_44100_128" },
        body: { text: "Door creak", duration_seconds: 3 },
      },
    }),
  },
  {
    name: "voice-change",
    alias: () =>
      buildVoiceChangeInput({
        voiceId: "voice_1",
        file: audio,
        model: "eleven_english_sts_v2",
        format: "mp3_44100_128",
      }),
    call: () => ({
      operationId: "speech_to_speech_full",
      input: {
        path: { voice_id: "voice_1" },
        query: { output_format: "mp3_44100_128" },
        files: { audio: resolve(audio) },
        body: { model_id: "eleven_english_sts_v2" },
      },
    }),
  },
  {
    name: "voice-change stream",
    alias: () => buildVoiceChangeInput({ stream: true, voiceId: "voice_1", file: audio }),
    call: () => ({
      operationId: "speech_to_speech_stream",
      input: { path: { voice_id: "voice_1" }, files: { audio: resolve(audio) } },
    }),
  },
  {
    name: "voice-isolate",
    alias: () => buildVoiceIsolateInput({ file: audio, fileFormat: "other" }),
    call: () => ({
      operationId: "audio_isolation",
      input: { files: { audio: resolve(audio) }, body: { file_format: "other" } },
    }),
  },
  {
    name: "dubbing create",
    alias: () => buildDubbingCreateInput({ file: video, source: "en", target: "es", name: "Dub" }),
    call: () => ({
      operationId: "create_dubbing",
      input: {
        files: { file: resolve(video) },
        body: { source_lang: "en", target_lang: "es", name: "Dub" },
      },
    }),
  },
  {
    name: "dubbing get",
    alias: () => buildDubbingGetInput({ id: "dub_1" }),
    call: () => ({ operationId: "get_dubbed_metadata", input: { path: { dubbing_id: "dub_1" } } }),
  },
  {
    name: "dubbing audio",
    alias: () => buildDubbingAudioInput({ id: "dub_1", language: "es" }),
    call: () => ({
      operationId: "get_dubbed_file",
      input: { path: { dubbing_id: "dub_1", language_code: "es" } },
    }),
  },
  {
    name: "dubbing list",
    alias: () => buildDubbingListInput({}),
    call: () => ({ operationId: "list_dubs", input: {} }),
  },
  {
    name: "voices list",
    alias: () => buildVoicesListInput({}),
    call: () => ({ operationId: "get_user_voices_v2", input: {} }),
  },
  {
    name: "voices find",
    alias: () => buildVoicesFindInput({ query: "juniper" }),
    call: () => ({ operationId: "get_user_voices_v2", input: { query: { search: "juniper" } } }),
  },
  {
    name: "voices get",
    alias: () => buildVoicesGetInput({ voiceId: "voice_1" }),
    call: () => ({ operationId: "get_voice_by_id", input: { path: { voice_id: "voice_1" } } }),
  },
  {
    name: "voices clone-instant",
    alias: () => buildVoicesCloneInstantInput({ name: "Clone", file: audio }),
    call: () => ({
      operationId: "add_voice",
      input: { files: { files: [resolve(audio)] }, body: { name: "Clone" } },
    }),
  },
  {
    name: "agents list",
    alias: () => buildAgentsListInput({ search: "demo" }),
    call: () => ({ operationId: "get_agents_route", input: { query: { search: "demo" } } }),
  },
  {
    name: "agents get",
    alias: () => buildAgentsGetInput({ agentId: "agent_1" }),
    call: () => ({ operationId: "get_agent_route", input: { path: { agent_id: "agent_1" } } }),
  },
  {
    name: "agents create",
    alias: () => buildAgentsCreateInput({ jsonFile: agentJson }),
    call: () => ({
      operationId: "create_agent_route",
      input: { body: { conversation_config: {}, name: "Agent" } },
    }),
  },
  {
    name: "agents update",
    alias: () => buildAgentsUpdateInput({ agentId: "agent_1", jsonFile: agentJson }),
    call: () => ({
      operationId: "patch_agent_settings_route",
      input: { path: { agent_id: "agent_1" }, body: { conversation_config: {}, name: "Agent" } },
    }),
  },
  {
    name: "agents simulate",
    alias: () => buildAgentsSimulateInput({ agentId: "agent_1", text: "Hi" }),
    call: () => ({
      operationId: "run_conversation_simulation_route",
      input: {
        path: { agent_id: "agent_1" },
        body: { simulation_specification: { first_message: "Hi" } },
      },
    }),
  },
  {
    name: "models list",
    alias: () => buildModelsListInput({}),
    call: () => ({ operationId: "get_models", input: {} }),
  },
  {
    name: "history list",
    alias: () => buildHistoryListInput({}),
    call: () => ({ operationId: "get_speech_history", input: {} }),
  },
  {
    name: "history audio",
    alias: () => buildHistoryAudioInput({ id: "hist_1" }),
    call: () => ({
      operationId: "get_audio_full_from_speech_history_item",
      input: { path: { history_item_id: "hist_1" } },
    }),
  },
  {
    name: "history delete",
    alias: () => buildHistoryDeleteInput({ id: "hist_1" }),
    call: () => ({
      operationId: "delete_speech_history_item",
      input: { path: { history_item_id: "hist_1" } },
    }),
  },
  {
    name: "usage",
    alias: () => buildUsageInput({}),
    call: () => ({ operationId: "get_user_subscription_info", input: {} }),
  },
  {
    name: "usage range",
    alias: () =>
      buildUsageInput({
        from: "2026-06-01",
        to: "2026-06-25",
        breakdown: "voice",
        metric: "credits",
      }),
    call: () => ({
      operationId: "usage_characters",
      input: {
        query: {
          start_unix: Date.parse("2026-06-01"),
          end_unix: Date.parse("2026-06-25"),
          breakdown_type: "voice",
          metric: "credits",
        },
      },
    }),
  },
];

writeFileSync(join(tmpdir(), "noop"), "");
writeFileSync(join(tmpdir(), "noop2"), "");

describe("curated aliases", () => {
  beforeAll(() => writeFileSync(join(dir, "script.txt"), "From file"));

  it.each(cases)(
    "$name builds a request semantically equal to elv call",
    async ({ alias, call }) => {
      const aliasBuilt = alias();
      const callBuilt = call();
      expect(aliasBuilt.operationId).toBe(callBuilt.operationId);

      const op = await operation(aliasBuilt.operationId);
      const aliasReq = await comparableRequest(op, aliasBuilt.input);
      const callReq = await comparableRequest(op, callBuilt.input);

      expect(aliasReq).toEqual(callReq);
    },
  );

  it("selects tts operation variants from stream/timestamps flags", () => {
    expect(buildTtsInput({ voiceId: "v", text: "x" }).operationId).toBe("text_to_speech_full");
    expect(buildTtsInput({ stream: true, voiceId: "v", text: "x" }).operationId).toBe(
      "text_to_speech_stream",
    );
    expect(buildTtsInput({ timestamps: true, voiceId: "v", text: "x" }).operationId).toBe(
      "text_to_speech_full_with_timestamps",
    );
    expect(
      buildTtsInput({ stream: true, timestamps: true, voiceId: "v", text: "x" }).operationId,
    ).toBe("text_to_speech_stream_with_timestamps");
  });

  it("converts usage date flags to unix milliseconds", () => {
    expect(buildUsageInput({ from: "2026-06-01", to: "2026-06-25" })).toEqual({
      operationId: "usage_characters",
      input: { query: { start_unix: 1780272000000, end_unix: 1782345600000 } },
    });
  });

  it("matches voices by exact name first, then substring", () => {
    const voices = [
      { name: "Juniper", voice_id: "v1" },
      { name: "Juniper Pro", voice_id: "v2" },
      { name: "Atlas", voice_id: "v3" },
    ];
    expect(findMatchingVoices("juniper", voices)).toEqual([voices[0]]);
    expect(findMatchingVoices("pro", voices)).toEqual([voices[1]]);
  });

  it("buildVoicesListInput passes search/sort in query without page_size", () => {
    expect(buildVoicesListInput({ search: "x", sort: "name" })).toEqual({
      operationId: "get_user_voices_v2",
      input: { query: { search: "x", sort: "name" } },
    });
  });
});

async function operation(operationId: string): Promise<OperationCard> {
  const op = (await registry).get(operationId);
  if (!op) throw new Error(`missing operation ${operationId}`);
  return op;
}

async function comparableRequest(op: OperationCard, input: AgentInput) {
  const req = await buildHttpRequest(op, normalizeInput(op, input, { allowUnknown: true }), {
    baseUrl: "https://api.test",
    apiKey: "key",
  });
  return {
    method: req.method,
    path: req.path,
    query: Object.fromEntries(new URL(req.url).searchParams.entries()),
    headers: Object.fromEntries(
      Object.entries(req.headers).filter(([key]) => !key.toLowerCase().startsWith("content-type")),
    ),
    body:
      req.body instanceof FormData
        ? await formMap(req.body)
        : req.body
          ? JSON.parse(req.body)
          : undefined,
  };
}

async function formMap(form: FormData): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const [key, value] of form.entries()) {
    const item =
      value instanceof Blob
        ? { name: (value as File).name, size: value.size, type: value.type }
        : value;
    out[key] = [...(out[key] ?? []), item];
  }
  return out;
}
