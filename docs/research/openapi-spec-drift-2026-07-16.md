# ElevenLabs OpenAPI drift research - 2026-07-16

## Executive summary

The vendored snapshot is stale but the generic CLI architecture is still compatible with the current REST API.

- Vendored `spec/openapi.snapshot.json`: 256 paths, 320 raw operations, 1 deliberate `x-skip-spec`, 319 callable operations, 1,284 schemas.
- Live official OpenAPI fetched 2026-07-16 17:25:54 UTC: 268 paths, 339 raw operations, the same 1 deliberate skip, 338 callable operations, 1,345 schemas.
- Net REST drift: **12 paths, 19 operations, and 61 schemas**. There are no removed paths or operations. Schema churn is larger: 74 added, 13 removed, and 141 same-name schemas changed.
- The existing compiler successfully compiled all 339 live operations and excluded only `get_signed_url_deprecated`, as designed.
- `elv call` can cover the 19 additions after `elv spec update`; `elv http` can call arbitrary new paths even before a registry refresh. The vendored/offline discovery surface cannot see them yet.
- The 21 ergonomic alias operation IDs all still exist. However, `agents simulate` targets an endpoint now marked deprecated, and the CLI currently stores but does not surface OpenAPI deprecation metadata.
- The official model reference has not introduced a model ID literal that is absent from the live spec but newly present relative to the snapshot. The important recent model change, Music v2, was already represented in the snapshot. The new REST capability is detailed Music SSE streaming.
- OpenAPI is not the entire service area. ElevenLabs publishes WebSocket/AsyncAPI documentation separately. The CLI catalog covers TTS, multi-context TTS, realtime STT, and agent conversations, but omits the documented enterprise conversation-monitor WebSocket. Arbitrary `elv ws <url>` remains an escape hatch.

## Sources and provenance

Primary sources:

- [Official machine-readable OpenAPI](https://api.elevenlabs.io/openapi.json)
- [Official July 6, 2026 changelog](https://elevenlabs.io/docs/changelog/2026/7/6)
- [Official June 29, 2026 changelog](https://elevenlabs.io/docs/changelog/2026/6/29)
- [Official models reference](https://elevenlabs.io/docs/overview/models)
- [Official API introduction](https://elevenlabs.io/docs/api-reference/introduction)
- [Official agent WebSocket/AsyncAPI reference](https://elevenlabs.io/docs/eleven-agents/api-reference/eleven-agents/websocket)
- [Official realtime conversation monitoring guide](https://elevenlabs.io/docs/eleven-agents/guides/realtime-monitoring)
- [Official realtime TTS WebSocket guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tts)

Context7 resolved ElevenLabs to `/websites/elevenlabs_io` (High reputation, 5,712 snippets, benchmark 84.74). Exa was restricted to official `elevenlabs.io` results.

Snapshot provenance:

```text
commit: 95e7cbc19911384af9d750e3be19c86046868521
commit date: 2026-06-25T13:40:04-05:00
commit subject: P1 baseline: toolchain, deps, gate scripts, shared types contract, vendored snapshot
```

Fetched document identity:

```text
snapshot bytes: 1,732,386
snapshot sha256: 447f27476b3e7979b081ee37147f0b74da413504c1b17e6c53eeefe01455e61b
live bytes:      1,836,863
live sha256:     de0476611805f3ee4e6a6c76dcdd6cc9686b8daee5757e6465d2974094c844ce
HTTP date:       Thu, 16 Jul 2026 17:25:54 GMT
content-type:    application/json
```

The live response did not include `ETag` or `Last-Modified`, and the OpenAPI `info.version` remains the non-specific `1.0`. The response date and SHA-256 are therefore the reproducible point-in-time identity.

## Reproduction commands

### Documentation discovery

```bash
npx ctx7@latest library "ElevenLabs" \
  "Research current ElevenLabs API updates, newly released models and tools, compare the complete official API surface and machine-readable OpenAPI definition to a checked-in CLI snapshot, including operation paths, schemas, realtime WebSocket APIs, and model IDs."

npx ctx7@latest docs /websites/elevenlabs_io \
  "Research current ElevenLabs API updates, newly released models and tools, compare the complete official API surface and machine-readable OpenAPI definition to a checked-in CLI snapshot, including operation paths, schemas, realtime WebSocket APIs, and model IDs. Identify the official OpenAPI JSON URL if documented."

exa-agent search "ElevenLabs API changelog 2026 new API endpoints models" \
  --include-domain elevenlabs.io --num-results 10 --text 2500 --json

exa-agent contents \
  'https://elevenlabs.io/docs/changelog/2026/7/6' \
  'https://elevenlabs.io/docs/changelog/2026/6/29' \
  --text 10000 --json
```

### Fetch and counts

```bash
curl --fail --silent --show-error --location \
  --dump-header /tmp/elv-openapi-headers.txt \
  'https://api.elevenlabs.io/openapi.json' \
  --output /tmp/elv-openapi-live.json

shasum -a 256 spec/openapi.snapshot.json /tmp/elv-openapi-live.json
wc -c spec/openapi.snapshot.json /tmp/elv-openapi-live.json

jq '{
  openapi,
  info,
  path_count: (.paths | length),
  operation_count: ([
    .paths[] | to_entries[] |
    select(.key | IN("get","put","post","delete","options","head","patch","trace"))
  ] | length),
  schema_count: (.components.schemas | length),
  tags_count: (.tags | length)
}' /tmp/elv-openapi-live.json
```

### Exact path and operation set diff

```bash
jq -r '
  .paths | to_entries[] as $p |
  $p.value | to_entries[] |
  select(.key | IN("get","put","post","delete","options","head","patch","trace")) |
  [(.key | ascii_upcase), $p.key, (.value.operationId // "<missing>")] | @tsv
' spec/openapi.snapshot.json | LC_ALL=C sort > /tmp/elv-old-ops.tsv

jq -r '
  .paths | to_entries[] as $p |
  $p.value | to_entries[] |
  select(.key | IN("get","put","post","delete","options","head","patch","trace")) |
  [(.key | ascii_upcase), $p.key, (.value.operationId // "<missing>")] | @tsv
' /tmp/elv-openapi-live.json | LC_ALL=C sort > /tmp/elv-new-ops.tsv

comm -13 /tmp/elv-old-ops.tsv /tmp/elv-new-ops.tsv # additions
comm -23 /tmp/elv-old-ops.tsv /tmp/elv-new-ops.tsv # removals
```

### Read-only compatibility compile

This compiles from `/tmp`; unlike `elv spec update`, it does not write the registry cache.

```bash
npx tsx -e '
  import { compileSpec } from "./src/openapi/compile-spec.ts";
  void (async () => {
    const r = await compileSpec({ sourcePath: "/tmp/elv-openapi-live.json" });
    console.log(JSON.stringify({
      operations: r.operations.length,
      totalOperations: r.totalOperations,
      skippedOperations: r.skippedOperations,
    }));
  })();
'
```

Result:

```json
{"operations":338,"totalOperations":339,"skippedOperations":1}
```

## REST operation and path drift

### Added operations (19)

```text
DELETE /v1/dubbing/project/{project_id}                                                       dubbing_project_delete
DELETE /v1/dubbing/project/{project_id}/language/{language_id}                                dubbing_language_delete
DELETE /v1/dubbing/project/{project_id}/transcript/segment/{segment_id}                       dubbing_transcript_segment_delete
GET    /v1/dubbing/project                                                                     dubbing_project_list
GET    /v1/dubbing/project/{project_id}                                                        dubbing_project_get
GET    /v1/dubbing/project/{project_id}/language                                               dubbing_language_list
GET    /v1/dubbing/project/{project_id}/language/{language_id}                                 dubbing_language_get
GET    /v1/dubbing/project/{project_id}/language/{language_id}/transcript                      dubbing_target_transcript_get
GET    /v1/dubbing/project/{project_id}/transcript                                             dubbing_transcript_get
GET    /v1/workspace/members                                                                   get_workspace_members
PATCH  /v1/dubbing/project/{project_id}/language/{language_id}/transcript/segment/{segment_id} dubbing_target_transcript_segment_update
PATCH  /v1/dubbing/project/{project_id}/transcript/segment/{segment_id}                        dubbing_transcript_segment_update
POST   /v1/convai/agents/{agent_id}/knowledge-base/rag-query                                  query_agent_knowledge_base_rag_route
POST   /v1/dubbing/project                                                                     dubbing_project_create
POST   /v1/dubbing/project/{project_id}/language                                               dubbing_language_create
POST   /v1/dubbing/project/{project_id}/language/{language_id}/transcript/regenerate           dubbing_target_transcript_regenerate
POST   /v1/dubbing/project/{project_id}/transcript/segment                                     dubbing_transcript_segment_add
POST   /v1/music/detailed/stream                                                               compose_detailed_stream
POST   /v1/service-accounts                                                                    create_service_account
```

By service area: 15 dubbing project/transcript operations, 1 agent RAG diagnostic, 1 Music detailed stream, 1 workspace-members read, and 1 service-account creation operation.

There are **no removed operations** and no operation ID renames for an existing method/path pair.

### Added paths (12)

```text
/v1/convai/agents/{agent_id}/knowledge-base/rag-query
/v1/dubbing/project
/v1/dubbing/project/{project_id}
/v1/dubbing/project/{project_id}/language
/v1/dubbing/project/{project_id}/language/{language_id}
/v1/dubbing/project/{project_id}/language/{language_id}/transcript
/v1/dubbing/project/{project_id}/language/{language_id}/transcript/regenerate
/v1/dubbing/project/{project_id}/language/{language_id}/transcript/segment/{segment_id}
/v1/dubbing/project/{project_id}/transcript
/v1/dubbing/project/{project_id}/transcript/segment
/v1/dubbing/project/{project_id}/transcript/segment/{segment_id}
/v1/music/detailed/stream
```

`GET /v1/workspace/members` and `POST /v1/service-accounts` add methods to paths already present in the snapshot, so they do not increase the unique-path count.

There are **no removed paths**.

### Existing operations changed in place (17)

Material request/response/deprecation changes:

- `POST /v1/convai/agents/{agent_id}/simulate-conversation` and `/stream`: now deprecated. Official replacement is Create test / Run tests.
- `GET /v1/pronunciation-dictionaries`: adds `include_archived` query parameter.
- `GET /v1/convai/users`: adds `sort_direction` query parameter.
- `GET /v1/convai/tools/{tool_id}`: adds `environment` query parameter.
- `GET /v1/convai/mcp-servers/{mcp_server_id}/tools`: adds `environment` query parameter.
- `POST /v1/convai/mcp-servers/{mcp_server_id}/tool-configs`: adds `environment` query parameter.
- `PATCH /v1/convai/mcp-servers/{mcp_server_id}/tool-configs/{tool_name}`: adds `environment` query parameter.
- `POST /v1/workspace/auth-connections` and `PATCH /v1/workspace/auth-connections/{auth_connection_id}`: response union adds `RefreshTokenAuthResponse`.

Documentation or SDK metadata-only changes:

- `GET /v1/history`: description changed.
- `POST /v1/dubbing/resource/{dubbing_id}/speaker`: description changed.
- `POST /v1/workspaces/api-keys/disable`: description changed.
- `POST /v1/workspaces/api-keys/third-party-disabling`: description changed.
- `POST /v1/voices/{voice_id}/edit`: tags changed.
- Merge-preview and rebase-preview branch endpoints: Fern SDK group/method metadata changed.

## Schema drift

### Counts

```text
snapshot schemas:          1,284
live schemas:              1,345
added schema names:           74
removed schema names:         13
same-name schemas changed:   141
net schema increase:           61
```

### Added schema names (74)

```text
AgentKnowledgeBaseRagChunkResponseModel
AgentKnowledgeBaseRagQueryRequestModel
AgentKnowledgeBaseRagQueryResponseModel
AgentTransfer-Input
AgentTransfer-Output
AgentTransferOp
AgentTransferOpPop
AgentTransferOpPush
AgentTransferOpReplace
AlertingSettingsResponse
AlertingWebhookHeader
AlertingWebhookMethod
AlertingWebhookNotifierResponse
AuthConnectionStatus
AutoGenerationMetadata
Body_Create_Dubbing_Language_Target_v1_dubbing_project__project_id__language_post
Body_Create_Dubbing_Project_v1_dubbing_project_post
Body_Stream_composed_music_with_a_detailed_response_v1_music_detailed_stream_post
Body_create_service_account_v1_service_accounts_post
ContentFormat
ConversationReasoningModel
CrawlStatus
CriteriaScoringMode
DefaultSharingGroupConfig
DubbingLanguageListResponse
DubbingLanguageOutputs
DubbingLanguageResponse
DubbingProjectListResponse
DubbingProjectResponse
DubbingSegmentCreateRequest
DubbingSegmentUpdateRequest
DubbingSourceMediaInfo
DubbingSourceSegmentUpdateResponse
DubbingSourceTranscriptResponse
DubbingTargetSegmentUpdateRequest
DubbingTargetSegmentUpdateResponse
DubbingTargetTranscriptResponse
DubbingTargetTranscriptSegment
DubbingTranscriptRevisionResponse
DubbingTranscriptSegment
DynamicVariablesConfig
DynamicVariablesConfigWorkflowOverride
ExternalSyncJobTrigger
ExternalSyncJobType
ExternalSyncProvider
InternalAlertingWebhookNotifier
KbExternalSyncJob
NumericDistributionAggregate
OpenerConfig
PlatformCategory
PlatformCategoryUsage
PlatformUsage
RefreshTokenAuthResponse
RunSubagentToolConfig-Input
RunSubagentToolConfig-Output
RunSubagentToolResultErrorModel
RunSubagentToolResultSuccessModel
SentimentAnalysisSettings
SimulationLibrarySettings
SubAgent-Input
SubAgent-Output
ToolInterruptionMode
TopicEvaluationCriteriaAggregate
TopicMetricsAggregate
TopicSentimentAggregate
TranscriptionOrderItemRequest
TransferToAgentToolConfig-Input
TransferToAgentToolConfig-Output
TransferToAgentToolResultSuccessModel-Input
TransferToAgentToolResultSuccessModel-Output
VoiceSettings
WorkspaceCreateServiceAccountResponseModel
WorkspaceMemberResponseModel
WorkspaceWebhookEventType
```

### Removed schema names (13)

```text
AgentTransfer
DynamicVariableNestedValueType-Input
DynamicVariableNestedValueType-Output
DynamicVariableValueType-Input
DynamicVariableValueType-Output
DynamicVariablesConfig-Input
DynamicVariablesConfig-Output
DynamicVariablesConfigWorkflowOverride-Input
DynamicVariablesConfigWorkflowOverride-Output
ExternalSyncType
OAuthConnectionStatus
TransferToAgentToolConfig
TransferToAgentToolResultSuccessModel
```

These removals are mostly schema normalization/replacement, not removed endpoints: unsuffixed dynamic-variable schemas replace duplicated input/output variants; `AuthConnectionStatus` replaces the OAuth-only status; transfer models split into input/output forms.

### High-signal same-name schema changes

- Agent tools/MCP: `interruption_mode`, response filtering, and sub-agent/transfer model changes.
- Agent reasoning and evaluation: numeric scoring, `reasoning`, `reasoned`, `enable_reasoning_summary`, topic metrics, sentiment, and call-success fields.
- Agent billing: `platform_charge`, `platform_price`, `platform_usage`, and `cost_fiat` additions.
- Auth connections: shared status fields across Basic, Bearer, OAuth, mTLS, custom header, Slack, URL secret, and WhatsApp response types.
- Workspace: `flows` and `templates` permissions, service-account/member shapes, webhook event selection, and new external-sync resource types.
- Studio captions: blur, border-radius, cursor, `typewriter`, `slam`, `scale_down`, and `slide_in` additions.
- Telephony: `agent_id` on Twilio/Exotel/SIP creation plus SMS/UUI-related fields.
- Knowledge base: content formats, active sync jobs, crawl/external-sync types, and the agent RAG query models.

Notable enum additions include:

```text
ConversationInitiationSource: salesforce_integration, subagent_tool
OrderItemKind: transcription
PermissionType: flows, templates
UsersSortBy: average_sentiment_score
WebhookEventType: unredacted_transcript, unredacted_audio
WorkspaceGroupPermission: flows, templates
WorkspaceResourceType: convai_kb_external_sync_jobs
```

To reproduce the full list of 141 changed common schemas, canonicalize each schema with recursively sorted object keys, SHA-256 the canonical JSON, and compare hashes by schema name. Array order must remain intact.

## Models

### Current official model reference

The official model page currently lists these service model IDs:

```text
eleven_v3
eleven_ttv_v3
eleven_multilingual_v2
eleven_flash_v2_5
eleven_flash_v2
eleven_multilingual_sts_v2
eleven_multilingual_ttv_v2
eleven_english_sts_v2
scribe_v2_realtime
scribe_v2
eleven_text_to_sound_v2
music_v2
music_v1
```

It separately marks `eleven_turbo_v2_5`, `eleven_turbo_v2`, and `scribe_v1` deprecated, recommending Flash v2.5, Flash v2, and Scribe v2 respectively.

### Snapshot-to-live model drift

- No new model ID string was introduced between the snapshot and current OpenAPI.
- `music_v2`, `scribe_v2`, `eleven_v3`, `eleven_ttv_v3`, `eleven_text_to_sound_v2`, and the other request-enumerated IDs were already present in the snapshot.
- `eleven_multilingual_sts_v2` is discoverable from `GET /v1/models`, not enumerated in either OpenAPI document's speech-to-speech request schema.
- `scribe_v2_realtime` belongs to the realtime WebSocket surface and is not enumerated in either REST OpenAPI document. The CLI already uses it as the `stt-realtime` catalog default.

A live, read-only `node dist/cli.js models list` succeeded and returned 10 account-visible TTS/STS model records:

```text
eleven_v3
eleven_multilingual_v2
eleven_flash_v2_5
eleven_turbo_v2_5
eleven_turbo_v2
eleven_flash_v2
eleven_english_sts_v2
eleven_monolingual_v1
eleven_multilingual_sts_v2
eleven_multilingual_v1
```

That endpoint is not a complete cross-product catalog: it does not return the separately documented STT, realtime STT, sound, voice-design, music, or dubbing model IDs. The CLI should not treat `models list` as exhaustive validation for arbitrary `model_id` fields.

## CLI coverage assessment

### What works without implementation changes

- Live OpenAPI compilation: 338 callable operations compile successfully.
- All 21 existing alias operation IDs are still present in the live OpenAPI.
- Generic `elv call <operation_id>` covers every compiled operation after a cache refresh.
- Generic `elv http <method> <path>` can reach paths absent from the current snapshot.
- The new dubbing project create operation is correctly recognized as multipart with file field `file`.
- The new detailed Music stream is recognized as `text/event-stream` / `streamKind: "text"`.
- New DELETE operations are automatically destructive and require `--yes` under the existing safety rules.
- `create_service_account` is recognized as an external side effect through the existing service-account risk pattern.

### Gaps exposed by the drift

1. **Vendored/offline registry is stale.** Fresh installs and `elv spec update --offline` expose 319 rather than 338 callable operations.
2. **No spec-diff/check mode.** `elv spec update` writes raw and compiled cache files but does not report added/removed/changed operations or schemas, and it does not update the vendored snapshot.
3. **Risk/cost metadata lags generated operations.** Every new operation currently has `costHint: "unknown"`. In particular, `compose_detailed_stream` is classified generic `mutate`, not `generate`, so the budget estimator does not recognize the Music generation cost. New dubbing generation/regeneration operations also need deliberate cost review.
4. **Deprecation is invisible at runtime.** The compiler records `deprecated`, but no command uses it. `agents simulate` therefore silently invokes an officially deprecated operation.
5. **Alias coverage is intentionally narrow.** There are 21 alias operation IDs versus 338 callable REST operations. This is acceptable for full coverage because `call` is the primary surface, but recent high-value workflows (dubbing project editing and detailed Music SSE) have no ergonomic aliases.
6. **POST does not mean mutation.** `query_agent_knowledge_base_rag_route` is officially read-only but classifies as generic `mutate`. That does not currently trigger `--yes`, but it is misleading discovery metadata.
7. **SSE semantics need an end-to-end check.** The compiler sees the new Music endpoint as text streaming, but a real no-cost fixture/mocked SSE test is needed to prove event framing, base64 audio handling, output bounding, and file spill behavior.
8. **OpenAPI is not the WebSocket contract.** Current official docs expose AsyncAPI inline on WebSocket pages. The hard-coded catalog is a second manually maintained registry.
9. **WebSocket catalog omission.** Official docs expose `wss://api.elevenlabs.io/v1/convai/conversations/{conversation_id}/monitor`; it is absent from `src/ws/catalog.ts`. The generic URL escape hatch works, but discovery and auth guidance are missing.
10. **Model discovery is fragmented.** REST `GET /v1/models`, request-schema enums, realtime WebSocket defaults, and the official model page expose different subsets.

## Recommended implementation inputs for the parent plan

This report is research only; no implementation was performed. The plan should at minimum account for:

1. Replace the vendored snapshot with the pinned live document and add a deterministic drift report/check.
2. Add tests asserting 339 raw / 338 callable operations and the 19 new operation IDs.
3. Add risk/cost overrides for detailed Music streaming and any billable dubbing project operations after verifying provider billing semantics.
4. Surface `deprecated` in `ops get/search/schema` and invocation envelopes; migrate or de-emphasize `agents simulate` in favor of test APIs.
5. Add an ergonomic detailed Music SSE path only if the generic `call` UX cannot save/stream events cleanly; do not duplicate the runner.
6. Decide whether dubbing project transcript editing deserves aliases; full REST coverage itself does not require aliases.
7. Add the documented conversation monitor entry to the WebSocket catalog and validate its event/control contract from the official guide.
8. Treat models as runtime-discovered strings. Do not hard-reject valid model IDs merely because `GET /v1/models` omits product-specific or realtime IDs.

## Limitations

- This is a point-in-time diff against a mutable endpoint. The official OpenAPI publishes no useful semantic version, ETag, Last-Modified timestamp, or changelog pointer.
- The live models response is account/credential-visible state and may differ by plan, region, rollout, or entitlement. No secrets were printed or passed on the command line.
- No mutating, destructive, outbound-call, credit-consuming, or generation request was sent. The only provider API call through this CLI was read-only `models list`.
- `elv spec update` was not run because it writes the user cache. Compatibility was verified with an in-memory compile from `/tmp`.
- OpenAPI does not fully describe WebSocket/AsyncAPI, SDK-only Speech Engine behavior, beta/enterprise entitlements, UI-only ElevenCreative operations, or model availability by account.
- Official changelog pages explain announced changes but do not enumerate every structural delta in the live OpenAPI. The exact diff above is authoritative for the two captured JSON documents, not for unpublished backend capabilities.
