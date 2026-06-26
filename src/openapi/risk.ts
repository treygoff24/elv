import type { CostHint, OperationCard, Risk } from "./types";

// P7: curated lists reviewed against full 320-op set.
const DESTRUCTIVE_OP_IDS = new Set(["disable", "set_third_party_disabling_policy"]);

// P7: curated lists reviewed against full 320-op set.
const EXTERNAL_SIDE_EFFECT_OP_IDS = new Set([
  "add_member",
  "add_mcp_server_tool_approval_route",
  "add_mcp_tool_config_override_route",
  "cancel_batch_call",
  "create_auth_connection",
  "create_batch_call",
  "create_mcp_server_route",
  "create_secret_route",
  "create_service_account_api_key",
  "create_workspace_webhook_route",
  "delete_service_account_api_key",
  "edit_service_account_api_key",
  "edit_workspace_webhook_route",
  "handle_exotel_outbound_call",
  "handle_sip_trunk_outbound_call",
  "handle_twilio_outbound_call",
  "invite_user",
  "invite_users_bulk",
  "register_twilio_call",
  "remove_member",
  "retry_batch_call",
  "share_resource_endpoint",
  "unshare_resource_endpoint",
  "update_auth_connection",
  "update_mcp_server_config_route",
  "update_mcp_server_approval_policy_route",
  "update_mcp_tool_config_override_route",
  "update_secret_route",
  "update_whatsapp_account",
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
