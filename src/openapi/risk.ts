import type { CostHint, OperationCard, Risk } from "../core/types";

// P7: curated lists reviewed against full 320-op set.
const DESTRUCTIVE_OP_IDS = new Set(["disable", "set_third_party_disabling_policy"]);

// P7: curated lists reviewed against full 320-op set.
const EXTERNAL_SIDE_EFFECT_OP_IDS = new Set([
  "add_member",
  "cancel_batch_call",
  "create_batch_call",
  "create_service_account_api_key",
  "delete_service_account_api_key",
  "edit_service_account_api_key",
  "handle_exotel_outbound_call",
  "handle_sip_trunk_outbound_call",
  "handle_twilio_outbound_call",
  "invite_user",
  "invite_users_bulk",
  "register_twilio_call",
  "remove_member",
  "retry_batch_call",
  "update_workspace_member",
  "whatsapp_outbound_call",
  "whatsapp_outbound_message",
]);

// P7: curated lists reviewed against full 320-op set.
const GENERATE_OP_IDS = new Set([
  "add_language",
  "audio_isolation",
  "audio_isolation_stream",
  "compose_detailed",
  "compose_plan",
  "create_dubbing",
  "create_voice",
  "dub",
  "generate",
  "render",
  "separate_song_stems",
  "sound_generation",
  "speech_to_speech_full",
  "speech_to_speech_stream",
  "speech_to_text",
  "stream_compose",
  "text_to_dialogue",
  "text_to_dialogue_full_with_timestamps",
  "text_to_dialogue_stream",
  "text_to_dialogue_stream_with_timestamps",
  "text_to_speech_full",
  "text_to_speech_full_with_timestamps",
  "text_to_speech_stream",
  "text_to_speech_stream_with_timestamps",
  "text_to_voice",
  "text_to_voice_design",
  "text_to_voice_remix",
  "transcribe",
  "translate",
  "video_to_music",
]);

const COST_HINTS = new Map<string, CostHint>([
  ["add_language", "per_source_minute"],
  ["audio_isolation", "audio_seconds"],
  ["audio_isolation_stream", "audio_seconds"],
  ["compose_detailed", "per_generation"],
  ["compose_plan", "per_generation"],
  ["create_dubbing", "per_source_minute"],
  ["create_voice", "slot"],
  ["dub", "per_source_minute"],
  ["generate", "per_generation"],
  ["render", "per_source_minute"],
  ["separate_song_stems", "per_generation"],
  ["sound_generation", "per_generation"],
  ["speech_to_speech_full", "audio_seconds"],
  ["speech_to_speech_stream", "audio_seconds"],
  ["speech_to_text", "audio_seconds"],
  ["stream_compose", "per_generation"],
  ["text_to_dialogue", "characters"],
  ["text_to_dialogue_full_with_timestamps", "characters"],
  ["text_to_dialogue_stream", "characters"],
  ["text_to_dialogue_stream_with_timestamps", "characters"],
  ["text_to_speech_full", "characters"],
  ["text_to_speech_full_with_timestamps", "characters"],
  ["text_to_speech_stream", "characters"],
  ["text_to_speech_stream_with_timestamps", "characters"],
  ["text_to_voice", "slot"],
  ["text_to_voice_design", "slot"],
  ["text_to_voice_remix", "slot"],
  ["transcribe", "per_source_minute"],
  ["translate", "per_source_minute"],
  ["video_to_music", "per_generation"],
]);

export function classifyRisk(op: Pick<OperationCard, "method" | "operationId">): Risk {
  if (op.method === "GET" || op.method === "HEAD") return "read";
  if (op.method === "DELETE") return "destructive";
  if (DESTRUCTIVE_OP_IDS.has(op.operationId)) return "destructive";
  if (EXTERNAL_SIDE_EFFECT_OP_IDS.has(op.operationId)) return "external_side_effect";
  if (GENERATE_OP_IDS.has(op.operationId)) return "generate";
  return "mutate";
}

export function costHintForOperationId(operationId: string): CostHint {
  return COST_HINTS.get(operationId) ?? "unknown";
}
