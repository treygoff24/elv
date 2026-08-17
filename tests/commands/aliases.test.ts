import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildAgentConversationSummaryInput,
  buildAgentsCreateInput,
  buildAgentsGetInput,
  buildAgentsListInput,
  buildAgentsSimulateInput,
  buildAgentsUpdateInput,
} from "../../src/commands/aliases/agents";
import {
  buildAssetsDeleteInput,
  buildAssetsGetInput,
  buildAssetsListInput,
  buildAssetsUploadInput,
} from "../../src/commands/aliases/assets";
import {
  buildDubbingAudioInput,
  buildDubbingCreateInput,
  buildDubbingGetInput,
  buildDubbingListInput,
} from "../../src/commands/aliases/dubbing";
import {
  buildFlowCreateInput,
  buildFlowGetInput,
  buildFlowListInput,
} from "../../src/commands/aliases/flows";
import {
  buildHistoryAudioInput,
  buildHistoryDeleteInput,
  buildHistoryListInput,
} from "../../src/commands/aliases/history";
import { buildModelsListInput } from "../../src/commands/aliases/models";
import { buildMusicInput } from "../../src/commands/aliases/music";
import { buildSfxInput } from "../../src/commands/aliases/sfx";
import { buildSttInput } from "../../src/commands/aliases/stt";
import { buildTtsInput } from "../../src/commands/aliases/tts";
import { buildUsageInput } from "../../src/commands/aliases/usage";
import { buildVoiceChangeInput } from "../../src/commands/aliases/voice-change";
import { buildVoiceIsolateInput } from "../../src/commands/aliases/voice-isolate";
import {
  buildVoicesCloneInstantInput,
  buildVoicesFindInput,
  buildVoicesGetInput,
  buildVoicesListInput,
  findMatchingVoices,
} from "../../src/commands/aliases/voices";
import { registerAliases } from "../../src/commands/aliases/index";
import { buildHttpRequest, normalizeInput } from "../../src/core/request-builder";
import { loadRegistry } from "../../src/openapi/registry";
import type { BuiltOperation } from "../../src/commands/aliases/shared";
import type { AgentInput } from "../../src/core/types";
import type { OperationCard } from "../../src/openapi/types";

let dir: string;
let audio: string;
let video: string;
let agentJson: string;
let asset: string;
let registry: Promise<Map<string, OperationCard>>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "elv-aliases-"));
  audio = join(dir, "audio.wav");
  video = join(dir, "video.mp4");
  asset = join(dir, "asset.png");
  agentJson = join(dir, "agent.json");
  writeFileSync(audio, "audio");
  writeFileSync(video, "video");
  writeFileSync(asset, "asset");
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
        webhook: true,
        webhookId: "webhook_1",
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
          webhook: true,
          webhook_id: "webhook_1",
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
    name: "assets list",
    alias: () => buildAssetsListInput({ search: "logo", cursor: "cur_1" }),
    call: () => ({
      operationId: "list_assets",
      input: { query: { search: "logo", cursor: "cur_1" } },
    }),
  },
  {
    name: "assets get",
    alias: () => buildAssetsGetInput({ id: "asset_1" }),
    call: () => ({ operationId: "get_asset", input: { path: { asset_id: "asset_1" } } }),
  },
  {
    name: "assets upload",
    alias: () => buildAssetsUploadInput({ file: asset, name: "Logo" }),
    call: () => ({
      operationId: "upload_asset",
      input: { files: { asset: resolve(asset) }, body: { name: "Logo" } },
    }),
  },
  {
    name: "assets delete",
    alias: () => buildAssetsDeleteInput({ id: "asset_1" }),
    call: () => ({
      operationId: "delete_asset_endpoint",
      input: { path: { asset_id: "asset_1" } },
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
        body: {
          simulation_specification: { simulated_user_config: { first_message: "Hi" } },
        },
      },
    }),
  },
  {
    name: "agents conversation summary",
    alias: () =>
      buildAgentConversationSummaryInput({ conversationId: "conv_1", maxMessages: "12" }),
    call: () => ({
      operationId: "get_conversation_summary_route",
      input: { path: { conversation_id: "conv_1" }, query: { max_messages: 12 } },
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
    name: "flows image create",
    alias: () =>
      buildFlowCreateInput("image", {
        json: JSON.stringify({ prompt: "blue fox", model_id: "gpt-image-1" }),
      }),
    call: () => ({
      operationId: "create_image_generation",
      input: { body: { prompt: "blue fox", model_id: "gpt-image-1" } },
    }),
  },
  {
    name: "flows image get",
    alias: () => buildFlowGetInput("image", { id: "gen_1" }),
    call: () => ({
      operationId: "get_image_generation",
      input: { path: { generation_id: "gen_1" } },
    }),
  },
  {
    name: "flows image list",
    alias: () =>
      buildFlowListInput("image", { status: "completed", modelId: "gpt-image-1", cursor: "c" }),
    call: () => ({
      operationId: "list_image_generations",
      input: { query: { status: "completed", model_id: "gpt-image-1", cursor: "c" } },
    }),
  },
  {
    name: "flows video create",
    alias: () =>
      buildFlowCreateInput("video", {
        json: JSON.stringify({ prompt: "blue fox", model_id: "video_v1" }),
      }),
    call: () => ({
      operationId: "create_video_generation",
      input: { body: { prompt: "blue fox", model_id: "video_v1" } },
    }),
  },
  {
    name: "flows video get",
    alias: () => buildFlowGetInput("video", { id: "gen_2" }),
    call: () => ({
      operationId: "get_video_generation",
      input: { path: { generation_id: "gen_2" } },
    }),
  },
  {
    name: "flows video list",
    alias: () => buildFlowListInput("video", { status: "failed" }),
    call: () => ({
      operationId: "list_video_generations",
      input: { query: { status: "failed" } },
    }),
  },
  {
    name: "flows speech create",
    alias: () =>
      buildFlowCreateInput("speech", {
        json: JSON.stringify({ text: "hello", voice_id: "voice_1", model_id: "eleven_v3" }),
      }),
    call: () => ({
      operationId: "create_text_to_speech_generation",
      input: { body: { text: "hello", voice_id: "voice_1", model_id: "eleven_v3" } },
    }),
  },
  {
    name: "flows speech get",
    alias: () => buildFlowGetInput("speech", { id: "gen_3" }),
    call: () => ({
      operationId: "get_text_to_speech_generation",
      input: { path: { generation_id: "gen_3" } },
    }),
  },
  {
    name: "flows speech list",
    alias: () => buildFlowListInput("speech", { modelId: "eleven_v3" }),
    call: () => ({
      operationId: "list_text_to_speech_generations",
      input: { query: { model_id: "eleven_v3" } },
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

  it("registers every alias command", () => {
    const program = new Command();
    registerAliases(program, (command) => command);

    expect(program.commands.map((command) => command.name()).sort()).toEqual([
      "agents",
      "assets",
      "dubbing",
      "dubbing-project",
      "flows",
      "history",
      "models",
      "music",
      "sfx",
      "stt",
      "tts",
      "usage",
      "voice-change",
      "voice-isolate",
      "voices",
      "workspace",
    ]);
  });

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

  it("assets upload defaults name to file basename", () => {
    expect(buildAssetsUploadInput({ file: asset })).toEqual({
      operationId: "upload_asset",
      input: { files: { asset: resolve(asset) }, body: { name: "asset.png" } },
    });
  });

  it.each(["0", "201", "1.5"])(
    "rejects invalid conversation summary --max-messages=%s",
    (value) => {
      expect(() =>
        buildAgentConversationSummaryInput({ conversationId: "conv_1", maxMessages: value }),
      ).toThrow("--max-messages must be an integer from 1 to 200");
    },
  );

  it.each(["1", "200"])("accepts boundary conversation summary --max-messages=%s", (value) => {
    const built = buildAgentConversationSummaryInput({
      conversationId: "conv_1",
      maxMessages: value,
    });

    expect(built.input.query?.max_messages).toBe(Number(value));
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

type FormValue = string | { name: string; size: number; type: string };

async function formMap(form: FormData): Promise<Record<string, FormValue[]>> {
  const out: Record<string, FormValue[]> = {};
  for (const [key, value] of form.entries()) {
    const item =
      value instanceof Blob
        ? { name: (value as File).name, size: value.size, type: value.type }
        : value;
    out[key] = [...(out[key] ?? []), item];
  }
  return out;
}
