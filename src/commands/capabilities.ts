import { success } from "../core/envelope";
import { ENVELOPE_VERSION, ExitCode } from "../core/types";
import { readVendoredMetadata } from "../openapi/fetch-spec";
import { loadRegistry, readRegistryCache, vendoredSpecPath } from "../openapi/registry";
import { listWsCatalog } from "../ws/catalog";
import type { CommandResult } from "../core/types";
import type { RegistryCache } from "../openapi/registry";
import type { OperationCard } from "../openapi/types";

interface CapabilitiesOptions {
  version: string;
}

interface VendoredOrigin {
  source: string;
  retrieved_at: string;
}

const COMMAND_FAMILIES = [
  ["capabilities", "Describe the bounded machine contract and discovery entry points."],
  ["ops", "List, search, inspect, and generate schemas for OpenAPI operations."],
  ["call", "Run a known OpenAPI operation by operation ID."],
  ["http", "Call an arbitrary REST method and path with shared safety controls."],
  [
    "ws",
    "List or run a scripted WebSocket catalog session; --duplex accepts live NDJSON actions on stdin.",
  ],
  ["wait", "Poll an operation or command until a status condition resolves."],
  ["view", "Inspect spilled JSON or NDJSON without loading the full result."],
  ["config", "Inspect configuration and diagnose auth/runtime readiness."],
  ["spec", "Inspect, compare, and refresh the local OpenAPI registry."],
] as const;

const ALIAS_FAMILIES = [
  {
    name: "agents",
    description:
      "Agent lifecycle, triage tickets, conversation summaries, procedures, response tests, and RAG query.",
    operation_ids: [
      "add_ticket_comment_route",
      "add_turn_comment_route",
      "compile_procedures_route",
      "create_agent_conversation_ticket_route",
      "create_agent_response_test_route",
      "create_agent_route",
      "create_manual_agent_ticket_route",
      "create_procedure_route",
      "delete_agent_conversation_ticket_route",
      "delete_chat_response_test_route",
      "delete_procedure_draft_route",
      "get_agent_conversation_ticket_route",
      "get_agent_response_test_route",
      "get_agent_route",
      "get_agents_route",
      "get_assignable_users_route",
      "get_conversation_summary_route",
      "get_procedure_draft_route",
      "get_procedure_route",
      "get_test_invocation_route",
      "list_agent_conversation_tickets_route",
      "list_chat_response_tests_route",
      "list_procedures_route",
      "list_test_invocations_route",
      "list_workspace_conversation_tickets_route",
      "patch_agent_settings_route",
      "query_agent_knowledge_base_rag_route",
      "remove_procedure_route",
      "resubmit_tests_route",
      "run_agent_test_suite_route",
      "run_conversation_simulation_route",
      "update_agent_conversation_ticket_route",
      "update_agent_response_test_route",
      "update_procedure_draft_route",
    ],
  },
  {
    name: "assets",
    description: "Upload, list, inspect, and delete reusable media assets.",
    operation_ids: ["delete_asset_endpoint", "get_asset", "list_assets", "upload_asset"],
  },
  {
    name: "dubbing",
    description: "Create, list, inspect, and download dubbing jobs.",
    operation_ids: ["create_dubbing", "get_dubbed_file", "get_dubbed_metadata", "list_dubs"],
  },
  {
    name: "dubbing-project",
    description: "Inspect and edit Dubbing Project source and target transcripts.",
    operation_ids: [
      "dubbing_target_transcript_get",
      "dubbing_target_transcript_regenerate",
      "dubbing_target_transcript_segment_update",
      "dubbing_target_transcript_segments_update",
      "dubbing_transcript_get",
      "dubbing_transcript_segment_add",
      "dubbing_transcript_segment_delete",
      "dubbing_transcript_segment_update",
      "dubbing_transcript_segments_update",
    ],
  },
  {
    name: "flows",
    description: "Create, list, inspect, and wait for image, video, and speech generations.",
    operation_ids: [
      "create_image_generation",
      "create_text_to_speech_generation",
      "create_video_generation",
      "get_image_generation",
      "get_text_to_speech_generation",
      "get_video_generation",
      "list_image_generations",
      "list_text_to_speech_generations",
      "list_video_generations",
    ],
  },
  {
    name: "history",
    description: "List, download, and delete speech history.",
    operation_ids: [
      "delete_speech_history_item",
      "get_audio_full_from_speech_history_item",
      "get_speech_history",
    ],
  },
  {
    name: "models",
    description: "List models exposed by the Models API.",
    operation_ids: ["get_models"],
  },
  {
    name: "music",
    description: "Generate music and manage Music Finetunes.",
    operation_ids: [
      "compose_detailed_stream",
      "create_finetune",
      "delete_finetune",
      "generate",
      "get_finetune",
      "get_finetunes",
      "stream_compose",
      "update_finetune",
    ],
  },
  {
    name: "sfx",
    description: "Generate sound effects.",
    operation_ids: ["sound_generation"],
  },
  {
    name: "stt",
    description: "Transcribe audio and optionally wait for an asynchronous transcript.",
    operation_ids: ["get_transcript_by_id", "speech_to_text"],
  },
  {
    name: "tts",
    description: "Synthesize speech with optional streaming and timestamps.",
    operation_ids: [
      "text_to_speech_full",
      "text_to_speech_full_with_timestamps",
      "text_to_speech_stream",
      "text_to_speech_stream_with_timestamps",
    ],
  },
  {
    name: "usage",
    description: "Read subscription or dated usage data.",
    operation_ids: ["get_user_subscription_info", "usage_characters"],
  },
  {
    name: "voice-change",
    description: "Convert speech to another voice, with optional streaming.",
    operation_ids: ["speech_to_speech_full", "speech_to_speech_stream"],
  },
  {
    name: "voice-isolate",
    description: "Isolate speech from uploaded audio.",
    operation_ids: ["audio_isolation"],
  },
  {
    name: "voices",
    description: "List, filter, inspect, clone, and replicate voices; discover available accents.",
    operation_ids: [
      "add_voice",
      "get_user_voices_v2",
      "get_voice_accents",
      "get_voice_by_id",
      "replicate_voice_to_isolated_environment",
    ],
  },
  {
    name: "workspace",
    description: "List workspace members and manage service accounts.",
    operation_ids: [
      "create_service_account",
      "get_workspace_members",
      "get_workspace_service_accounts",
    ],
  },
] as const;

const ENVIRONMENT = [
  ["ELEVENLABS_API_KEY", "Default API-key environment variable; profiles may name another."],
  ["ELEVENLABS_API_RESIDENCY", "Select a residency host: us, eu, in, or sg."],
  ["ELEVENLABS_BASE_URL", "Override the REST and derived WebSocket base URL."],
  ["ELV_CACHE_DIR", "Override the registry and response cache root."],
  ["ELV_CONFIG", "Use an explicit JSON configuration file."],
  ["ELV_DEBUG", "Enable redacted diagnostic logging on stderr."],
  ["ELV_MAX_CREDITS", "Set the default pre-flight credit ceiling."],
  ["ELV_MAX_UPLOAD_BYTES", "Set the maximum accepted upload size."],
  ["ELV_OUTPUT_DIR", "Override the default output directory."],
  ["ELV_PROFILE", "Select a named configuration profile."],
  ["ELV_SPEC_URL", "Override the OpenAPI update source URL."],
] as const;

const EXIT_CODES = [
  [0, "success"],
  [2, "input_or_validation"],
  [3, "auth_or_permission"],
  [4, "confirmation_required"],
  [5, "budget_ceiling"],
  [6, "provider_credits_exhausted"],
  [7, "transient_retries_exhausted"],
  [8, "provider_or_runtime_error"],
  [9, "not_found"],
] as const;

export async function handleCapabilities(options: CapabilitiesOptions): Promise<CommandResult> {
  const registry = await loadRegistry();
  const cache = readRegistryCache();
  return {
    env: success({
      cmd: "elv capabilities",
      data: {
        cli: { name: "elv", version: options.version, envelope_version: ENVELOPE_VERSION },
        spec: specSummary(cache, registry.size),
        command_families: COMMAND_FAMILIES.map(([name, description]) => ({ name, description })),
        service_groups: serviceGroups(registry),
        alias_families: ALIAS_FAMILIES,
        websockets: listWsCatalog()
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((entry) => ({
            name: entry.name,
            path: entry.pathTemplate,
            auth: entry.auth,
            scriptable: entry.scriptable,
            duplex: entry.duplex,
            first_message: entry.firstMessage,
            terminal_rule: entry.terminalRule,
            required_params: entry.requiredParams,
          })),
        protocol: {
          stdout: "exactly_one_json_envelope",
          envelope_version: ENVELOPE_VERSION,
          realtime_transports: ["websocket"],
          exit_codes: EXIT_CODES.map(([code, meaning]) => ({ code, meaning })),
        },
        configuration: {
          environment: ENVIRONMENT.map(([name, purpose]) => ({ name, purpose })),
          precedence: [
            "command flag",
            "environment variable",
            "active profile",
            "built-in default",
          ],
          api_key: "Read only from the environment selected by the active profile; never argv.",
        },
        safety: {
          risk_classes: ["read", "mutate", "generate", "external_side_effect", "destructive"],
          confirmation_required_for: ["external_side_effect", "destructive"],
          confirmation_flag: "--yes",
          dry_run: "Validates and previews before confirmation and budget gates; makes no request.",
          budget_flag: "--max-credits",
          cost_policies: [
            "characters",
            "audio_seconds",
            "per_generation",
            "per_source_minute",
            "slot",
            "unknown",
          ],
          stream_kinds: ["none", "audio_bytes", "json_events", "sse_events", "text"],
        },
        next: [
          { cmd: "elv ops list --limit 100", why: "Browse the operation inventory." },
          {
            cmd: "elv ops schema <operation_id> --example",
            why: "Generate a runnable input skeleton.",
          },
          { cmd: "elv spec status", why: "Inspect active spec provenance and drift." },
          { cmd: "elv config doctor", why: "Check local runtime and credentials." },
        ],
      },
    }),
    exitCode: ExitCode.Success,
  };
}

/**
 * A registry compiled from the vendored snapshot records the local file it read and
 * the time it compiled, not where the document came from. `elv spec status` reports
 * the pinned source URL and retrieval date; report the same thing here.
 */
function pinnedOrigin(cache: RegistryCache | null): VendoredOrigin | null {
  if (!cache || cache.sourceSelector !== vendoredSpecPath()) return null;
  try {
    const metadata = readVendoredMetadata();
    return metadata.sha256 === cache.provenance.sha256
      ? { source: metadata.source, retrieved_at: metadata.retrieved_at }
      : null;
  } catch {
    return null;
  }
}

function serviceGroups(
  registry: Map<string, OperationCard>,
): { name: string; operations: number }[] {
  const counts = new Map<string, number>();
  for (const operation of registry.values()) {
    const group = operation.group[0] ?? "ungrouped";
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, operations]) => ({ name, operations }));
}

function specSummary(cache: RegistryCache | null, operations: number) {
  const provenance = cache?.provenance;
  const pinned = pinnedOrigin(cache);
  return {
    source: pinned?.source ?? provenance?.source ?? "registry_cache",
    retrieved_at: pinned?.retrieved_at ?? provenance?.retrieved_at ?? null,
    sha256: provenance?.sha256 ?? null,
    paths: provenance?.paths ?? null,
    total_operations: provenance?.total_operations ?? operations,
    callable_operations: provenance?.callable_operations ?? operations,
    skipped_operations: provenance?.skipped_operations ?? 0,
    schemas: provenance?.schemas ?? null,
    generated_at: cache?.generated_at ?? null,
  };
}
