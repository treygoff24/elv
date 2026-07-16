import type { CostHint, OperationCard, Risk } from "./types";

// Curated overrides for operations whose OpenAPI metadata understates risk/cost.
const DESTRUCTIVE_OP_IDS = new Set(["disable", "set_third_party_disabling_policy"]);

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

const READ_OP_IDS = new Set(["query_agent_knowledge_base_rag_route"]);

const GENERATE_OP_IDS = new Set([
  "add_language",
  "audio_isolation",
  "audio_isolation_stream",
  "compose_detailed",
  "compose_detailed_stream",
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
  ["compose_detailed_stream", "per_generation"],
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

const DESTRUCTIVE_PATTERNS = [/^delete_/u, /(^|_)disable(_|$)/u, /disabling_policy/u];

const EXTERNAL_SIDE_EFFECT_PATTERNS = [
  /(^|_)outbound(_|$)/u,
  /(^|_)invite(s|d)?(_|$)/u,
  /(^|_)member(s)?(_|$)/u,
  /api_?key/u,
  /service_?account/u,
  /secret/u,
  /webhook/u,
  /auth_?connection/u,
  /(^|_)mcp(_|$)/u,
  /phone_?number/u,
  /whatsapp/u,
  /twilio/u,
  /sip_?trunk/u,
  /exotel/u,
  /(^|_)share_resource(_|$)/u,
  /(^|_)unshare_resource(_|$)/u,
];

export function riskCurationInputs(): Record<string, unknown> {
  return {
    destructiveOperationIds: [...DESTRUCTIVE_OP_IDS].sort(),
    externalSideEffectOperationIds: [...EXTERNAL_SIDE_EFFECT_OP_IDS].sort(),
    readOperationIds: [...READ_OP_IDS].sort(),
    generateOperationIds: [...GENERATE_OP_IDS].sort(),
    costHints: [...COST_HINTS.entries()].sort(([a], [b]) => a.localeCompare(b)),
    destructivePatterns: DESTRUCTIVE_PATTERNS.map((pattern) => ({
      source: pattern.source,
      flags: pattern.flags,
    })),
    externalSideEffectPatterns: EXTERNAL_SIDE_EFFECT_PATTERNS.map((pattern) => ({
      source: pattern.source,
      flags: pattern.flags,
    })),
  };
}

export function riskCompilerSemanticsInputs(): Record<string, string> {
  return {
    classifyRisk: Function.prototype.toString.call(classifyRisk),
    costHintForOperationId: Function.prototype.toString.call(costHintForOperationId),
    riskText: Function.prototype.toString.call(riskText),
  };
}

export function classifyRisk(
  op: Pick<OperationCard, "method" | "operationId"> & Partial<Pick<OperationCard, "pathTemplate">>,
): Risk {
  if (READ_OP_IDS.has(op.operationId)) return "read";
  if (op.method === "GET" || op.method === "HEAD") return "read";
  if (op.method === "DELETE") return "destructive";
  if (DESTRUCTIVE_OP_IDS.has(op.operationId)) return "destructive";
  if (EXTERNAL_SIDE_EFFECT_OP_IDS.has(op.operationId)) return "external_side_effect";
  const riskKey = riskText(op);
  if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(riskKey))) return "destructive";
  if (EXTERNAL_SIDE_EFFECT_PATTERNS.some((pattern) => pattern.test(riskKey)))
    return "external_side_effect";
  if (GENERATE_OP_IDS.has(op.operationId)) return "generate";
  return "mutate";
}

export function costHintForOperationId(operationId: string): CostHint {
  return COST_HINTS.get(operationId) ?? "unknown";
}

function riskText(op: { operationId: string; pathTemplate?: string }): string {
  return `${op.operationId} ${op.pathTemplate ?? ""}`.toLowerCase().replace(/[^a-z0-9]+/gu, "_");
}
