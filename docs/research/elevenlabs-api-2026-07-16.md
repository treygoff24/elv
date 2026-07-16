# ElevenLabs API research: 2026-07-16

## Executive summary

The repository's vendored OpenAPI snapshot was committed on 2026-06-25. It contains 320 documented operations across 256 paths and 1,284 schemas. The live official ElevenLabs OpenAPI document fetched on 2026-07-16 contains 339 documented operations across 268 paths and 1,345 schemas. The live document adds 19 operation IDs and removes none.

The CLI is closer to full coverage than the stale snapshot suggests:

- `elv spec update` successfully compiled the live document into 338 callable operations. One deprecated signed-URL route is deliberately marked `x-skip-spec`; the current replacement remains callable.
- `elv http` can reach newly added REST paths even before the vendored snapshot is refreshed.
- The main gaps are offline discovery/validation, curated aliases, deprecation handling, and protocol-specific ergonomics—not a missing general HTTP transport.
- The new Music detailed stream is an SSE protocol. The current generic response path classifies it as text and saves the raw event stream; it does not yet split metadata to NDJSON and decode `audio_chunk` payloads into an audio file.
- The current `agents simulate` alias calls two upstream operations that became deprecated on July 6. ElevenLabs directs callers to Create test and Run tests on the agent instead.

No new model ID was confidently introduced after this repo's June 25 baseline. Music v2 was introduced on June 15 and is already represented in the baseline snapshot. The important post-baseline changes are new endpoints, agent configuration/tool schemas, workspace administration, and deprecations.

## Method and source hierarchy

Facts below were checked against primary ElevenLabs sources only:

1. The live [official OpenAPI JSON](https://api.elevenlabs.io/openapi.json), fetched 2026-07-16.
2. Official [July 6](https://elevenlabs.io/docs/changelog/2026/7/6), [July 13](https://elevenlabs.io/docs/changelog/2026/7/13), [June 29](https://elevenlabs.io/docs/changelog/2026/6/29), [June 15](https://elevenlabs.io/docs/changelog/2026/6/15), and [June 8](https://elevenlabs.io/docs/changelog/2026/6/8) changelogs.
3. Official [models overview](https://elevenlabs.io/docs/overview/models.mdx), [models API reference](https://elevenlabs.io/docs/api-reference/models/list), and credentialed `GET /v1/models` response on 2026-07-16.
4. Official API and AsyncAPI reference pages, including [Music detailed streaming](https://elevenlabs.io/docs/api-reference/music/compose-detailed-stream), [Speech Engine upstream WebSocket](https://elevenlabs.io/docs/api-reference/speech-engine), [TTS Multi-Context WebSocket](https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-multi-stream-input.mdx), [Agent WebSocket](https://elevenlabs.io/docs/eleven-agents/api-reference/eleven-agents/websocket), and [real-time monitoring](https://elevenlabs.io/docs/eleven-agents/guides/realtime-monitoring.mdx).
5. Local source and real CLI invocations for capability claims.

Reproducibility hashes:

| Artifact | SHA-256 |
| --- | --- |
| `spec/openapi.snapshot.json` | `447f27476b3e7979b081ee37147f0b74da413504c1b17e6c53eeefe01455e61b` |
| Live `https://api.elevenlabs.io/openapi.json`, fetched 2026-07-16 | `de0476611805f3ee4e6a6c76dcdd6cc9686b8daee5757e6465d2974094c844ce` |

## Baseline versus live REST API

| Measure | Vendored baseline | Live 2026-07-16 | Delta |
| --- | ---: | ---: | ---: |
| OpenAPI paths | 256 | 268 | +12 |
| Documented operation IDs | 320 | 339 | +19 |
| Operations compiled by `elv` | 319 | 338 | +19 |
| Component schemas | 1,284 | 1,345 | +61 |
| Removed operation IDs | - | - | 0 |

The one documented-but-uncompiled operation in both documents is deprecated `get_signed_url_deprecated` (`GET /v1/convai/conversation/get_signed_url`), which has `x-skip-spec: true`. The current `get_conversation_signed_link` operation (`GET /v1/convai/conversation/get-signed-url`) is available.

### The 19 new operation IDs

All rows below are confirmed directly in the live [official OpenAPI document](https://api.elevenlabs.io/openapi.json). "Changelog status" distinguishes announced additions from operations that appeared in the live spec without a matching entry in the June 29, July 6, or July 13 changelog pages reviewed.

| Operation ID | Method and path | Capability | Changelog status |
| --- | --- | --- | --- |
| `compose_detailed_stream` | `POST /v1/music/detailed/stream` | Stream composition plan, song metadata, base64 audio chunks, and optional word timestamps over SSE | Announced July 6 |
| `create_service_account` | `POST /v1/service-accounts` | Programmatically create a service account, including optional default sharing groups | Announced July 13 |
| `get_workspace_members` | `GET /v1/workspace/members` | List workspace human members and seat/owner/lock state; excludes service accounts | Announced July 13 |
| `query_agent_knowledge_base_rag_route` | `POST /v1/convai/agents/{agent_id}/knowledge-base/rag-query` | Query an agent's knowledge base through its RAG configuration | Present in live OpenAPI; no matching changelog entry found |
| `dubbing_project_create` | `POST /v1/dubbing/project` | Create a Dubbing Project | Present in live OpenAPI; no matching changelog entry found |
| `dubbing_project_list` | `GET /v1/dubbing/project` | List Dubbing Projects | Present in live OpenAPI; no matching changelog entry found |
| `dubbing_project_get` | `GET /v1/dubbing/project/{project_id}` | Get a Dubbing Project | Present in live OpenAPI; no matching changelog entry found |
| `dubbing_project_delete` | `DELETE /v1/dubbing/project/{project_id}` | Delete a Dubbing Project | Present in live OpenAPI; no matching changelog entry found |
| `dubbing_language_create` | `POST /v1/dubbing/project/{project_id}/language` | Create a target language | Present in live OpenAPI; no matching changelog entry found |
| `dubbing_language_list` | `GET /v1/dubbing/project/{project_id}/language` | List target languages | Present in live OpenAPI; no matching changelog entry found |
| `dubbing_language_get` | `GET /v1/dubbing/project/{project_id}/language/{language_id}` | Get a target language | Present in live OpenAPI; no matching changelog entry found |
| `dubbing_language_delete` | `DELETE /v1/dubbing/project/{project_id}/language/{language_id}` | Delete a target language | Present in live OpenAPI; no matching changelog entry found |
| `dubbing_transcript_get` | `GET /v1/dubbing/project/{project_id}/transcript` | Get the source transcript | Present in live OpenAPI; no matching changelog entry found |
| `dubbing_transcript_segment_add` | `POST /v1/dubbing/project/{project_id}/transcript/segment` | Add a source transcript segment | Present in live OpenAPI; no matching changelog entry found |
| `dubbing_transcript_segment_update` | `PATCH /v1/dubbing/project/{project_id}/transcript/segment/{segment_id}` | Update a source transcript segment | Present in live OpenAPI; no matching changelog entry found |
| `dubbing_transcript_segment_delete` | `DELETE /v1/dubbing/project/{project_id}/transcript/segment/{segment_id}` | Delete a source transcript segment | Present in live OpenAPI; no matching changelog entry found |
| `dubbing_target_transcript_get` | `GET /v1/dubbing/project/{project_id}/language/{language_id}/transcript` | Get a target-language transcript | Present in live OpenAPI; no matching changelog entry found |
| `dubbing_target_transcript_segment_update` | `PATCH /v1/dubbing/project/{project_id}/language/{language_id}/transcript/segment/{segment_id}` | Update a target transcript segment | Present in live OpenAPI; no matching changelog entry found |
| `dubbing_target_transcript_regenerate` | `POST /v1/dubbing/project/{project_id}/language/{language_id}/transcript/regenerate` | Regenerate a target-language dub/transcript | Present in live OpenAPI; no matching changelog entry found |

The 15 project-oriented Dubbing operations are confirmed public OpenAPI facts. Their release stage, account-tier requirements, and intended migration mapping from the older Dubbing Resource endpoints were not stated in the sources reviewed. The separate capitalized `Dubbing` tag and the older Resource endpoints' existing deprecation markers suggest a replacement generation, but that is an inference, not a confirmed migration announcement.

### June 29 changes that are already in the repo baseline

The official [June 29 changelog](https://elevenlabs.io/docs/changelog/2026/6/29) announced:

- `merge_preview_route`: `GET /v1/convai/agents/{agent_id}/branches/{source_branch_id}/merge-preview`
- `rebase_preview_route`: `GET /v1/convai/agents/{agent_id}/branches/{branch_id}/rebase-preview`
- `set_third_party_disabling_policy`: `POST /v1/workspaces/api-keys/third-party-disabling`
- Combined multichannel STT output through `multichannel_output_style: separate | combined`
- Auth connection status and bearer-auth update schemas
- Tool response filtering, telephony agent assignment, workflow UUI, sentiment fields, and workspace permission changes

Those three operation IDs are already present in the June 25 vendored snapshot, so they are not counted among the 19 current deltas. This indicates the baseline snapshot contained some schema changes before their public changelog date.

## Material changes after the baseline

### July 6

The [July 6 changelog](https://elevenlabs.io/docs/changelog/2026/7/6) confirms:

- **Music detailed SSE:** `compose_detailed_stream`, `POST /v1/music/detailed/stream`. The response is `text/event-stream`, not a normal audio byte stream. Events include the composition plan, song metadata, base64 audio chunks, optional word timestamps, and completion.
- **Agent simulation deprecation:** `run_conversation_simulation_route` (`POST /v1/convai/agents/{agent_id}/simulate-conversation`) and `run_conversation_simulation_route_stream` (`POST /v1/convai/agents/{agent_id}/simulate-conversation/stream`) are deprecated. The documented replacement flow is `create_agent_response_test_route` (`POST /v1/convai/agent-testing/create`) followed by `run_agent_test_suite_route` (`POST /v1/convai/agents/{agent_id}/run-tests`).
- **Tool interruption migration:** `disable_interruptions` is deprecated in favor of `interruption_mode`, whose values are `allow`, `disable_during_tool`, and `disable_during_tool_and_turn`. Tool-level overrides are supported.
- **Numeric evaluation scoring:** evaluation criteria can use `binary` or `numeric_uniform`, with optional `max_score` and `score_instructions`; results can include numeric scores.
- **Conversation reasoning:** history/transcript models can include reasoning summaries and agents can enable them.
- **Billing metadata:** platform charge/price/usage breakdowns and required USD `cost_fiat` were added to conversation metadata.
- **Webhook events:** `unredacted_transcript` and `unredacted_audio` were added.
- **Speech Engine SDK auth:** SDK clients gained an opt-out for SDK-managed auth for deployments protected by another mechanism. This is an SDK option, not a new REST operation.

### July 13

The [July 13 changelog](https://elevenlabs.io/docs/changelog/2026/7/13) confirms:

- **`run_subagent` system tool:** new `RunSubagentToolConfig` and `SubAgent` schemas allow an ElevenAgent to invoke configured subagents.
- **Nested agent transfers:** workflows gained push, pop, and replace transfer operations plus `enable_nesting` and `return_when_nested` controls.
- **Per-agent sentiment:** platform settings gained `sentiment_analysis`; aggregate sentiment schemas were expanded.
- **Transcript translation:** optional automatic translation to the app language.
- **Backchannel marking:** user turns can include `ignored_as_backchannel`.
- **MCP environment scoping:** `environment` was added to get/list/create/update MCP tool-configuration routes.
- **Knowledge-base external sync state:** provider/job schemas and `active_sync_job` were added.
- **Service-account creation and workspace-member listing:** the two new workspace operations above.
- **Agent TTS setting deprecation:** `optimize_streaming_latency` is deprecated and documented as a no-op in agent TTS settings.
- **SDK note:** JS/Python SDK v2.58.0 mentions multi-context text-to-dialogue WebSocket message types. No corresponding public OpenAPI operation or separately indexed AsyncAPI endpoint was found, so this should remain an investigation item rather than a confirmed CLI target.

## Model catalog and deprecations

### Currently documented model IDs

The official [models overview](https://elevenlabs.io/docs/overview/models.mdx) currently documents:

| Area | Model IDs |
| --- | --- |
| Text to Speech | `eleven_v3`, `eleven_multilingual_v2`, `eleven_flash_v2_5`, `eleven_flash_v2` |
| Text to Voice / Voice Design | `eleven_ttv_v3`, `eleven_multilingual_ttv_v2` |
| Speech to Speech | `eleven_multilingual_sts_v2`, `eleven_english_sts_v2` |
| Speech to Text | `scribe_v2`, `scribe_v2_realtime` |
| Sound Effects | `eleven_text_to_sound_v2` |
| Music | `music_v2`, `music_v1` |

The same page documents these deprecated models and replacements:

| Deprecated model | Suggested replacement |
| --- | --- |
| `eleven_turbo_v2_5` | `eleven_flash_v2_5` |
| `eleven_turbo_v2` | `eleven_flash_v2` |
| `scribe_v1` | `scribe_v2` |

The [June 8 changelog](https://elevenlabs.io/docs/changelog/2026/6/8) said `eleven_monolingual_v1`, `eleven_multilingual_v1`, and `scribe_v1` would be removed on July 9, 2026. A credentialed `GET /v1/models` request on July 16 still returned both v1 TTS models for the tested workspace. Therefore:

- The removal deadline was announced.
- Removal was not universal for the tested workspace as of July 16.
- Clients should treat those IDs as deprecated and migrate, but should not claim the server has already removed them everywhere.

### What `GET /v1/models` returned on 2026-07-16

The live [models endpoint](https://elevenlabs.io/docs/api-reference/models/list) returned 10 models for the authenticated workspace:

`eleven_english_sts_v2`, `eleven_flash_v2`, `eleven_flash_v2_5`, `eleven_monolingual_v1`, `eleven_multilingual_sts_v2`, `eleven_multilingual_v1`, `eleven_multilingual_v2`, `eleven_turbo_v2`, `eleven_turbo_v2_5`, and `eleven_v3`.

This endpoint is not a complete catalog of every product model: it omitted Scribe, Music, Text-to-Voice, and Sound Effects IDs that are documented elsewhere. `elv models list` should therefore be described as "models available from `/v1/models`" rather than as an exhaustive cross-product catalog.

### Model delta conclusion

No post-June-25 model launch was confirmed. [Music v2 was announced June 15](https://elevenlabs.io/docs/changelog/2026/6/15), before this repository's baseline, and its model ID already appears in the vendored spec. The CLI's aliases accept arbitrary model strings, so newly server-enabled model IDs generally do not require code changes; documentation, examples, validation assumptions, and deprecation guidance are the real maintenance points.

## Current public REST service map

The live OpenAPI's first-tag counts are below. ElevenLabs' tag capitalization is inconsistent, so `dubbing` and `Dubbing` are intentionally shown separately.

| Tag / service area | Operations | Representative capability |
| --- | ---: | --- |
| Agents Platform | 134 | Agents, conversations, tools, MCP, tests, branches, telephony, WhatsApp, batch calls, knowledge base, analytics |
| workspace | 29 | Members, service accounts/API keys, groups, invites, audit logs, auth connections, resource sharing, webhooks |
| studio | 23 | Studio projects, chapters, snapshots, conversion, audio, podcasts |
| dubbing | 20 | Existing dub creation/list/audio/transcript plus deprecated Resource APIs |
| Dubbing | 15 | New project/language/source transcript/target transcript API |
| pvc-voices | 14 | Professional voice creation, samples, training, speaker separation, verification |
| untagged | 14 | Miscellaneous service routes |
| voices | 12 | Voice CRUD, settings, library, similarity, instant cloning, v2 list |
| productions | 11 | Human-services orders, media, items, submission, deliverables |
| Pronunciation Dictionary | 9 | Dictionary CRUD/version/rule management |
| music-generation | 7 | Compose, stream, detailed responses, SSE details, plans, upload, stem separation |
| Speech Engine | 5 | Speech Engine resource CRUD/list |
| speech-history | 5 | Generated item list/get/delete/audio/download |
| text-to-voice | 5 | Voice design, creation, remix, preview streaming; one legacy preview route deprecated |
| audio-isolation | 4 | Convert/stream/history/delete history item |
| audio-native | 4 | Create, settings, content, URL content |
| text-to-dialogue | 4 | Full/streaming multi-voice dialogue, with or without timestamps |
| text-to-speech | 4 | Full/streaming TTS, with or without timestamps |
| Conversational AI | 3 | Knowledge-base folder/move operations |
| speech-to-text | 3 | Create/get/delete transcript |
| Agents Workspace Analytics | 2 | Conversation analysis/evaluation |
| access:all | 2 | Access-control operations |
| samples | 2 | Voice sample audio/delete |
| speech-to-speech | 2 | Full/streaming voice conversion |
| Agents Insights | 1 | Agent topics |
| Single Use Token | 1 | Short-lived token issuance |
| forced-alignment | 1 | Align audio with text |
| models | 1 | List model availability |
| sound-generation | 1 | Generate sound effects |
| video-to-music | 1 | Generate music from video |

## WebSocket and other non-REST surfaces

The public API is not only the OpenAPI document:

- **TTS WebSocket:** `/v1/text-to-speech/{voice_id}/stream-input`.
- **TTS Multi-Context WebSocket:** `/v1/text-to-speech/{voice_id}/multi-stream-input`; the official guide says it does not support `eleven_v3`.
- **Realtime STT:** `/v1/speech-to-text/realtime`, using `scribe_v2_realtime`.
- **Agent conversations:** `/v1/convai/conversation`.
- **Agent real-time monitoring:** `/v1/convai/conversations/{conversation_id}/monitor`; the [official guide](https://elevenlabs.io/docs/eleven-agents/guides/realtime-monitoring.mdx) labels this enterprise-only.
- **Speech Engine upstream:** `/speech-engine/upstream` is an inverted protocol: ElevenLabs connects as the WebSocket client to the customer's server. It is not a normal outbound `elv ws` target. The [official reference](https://elevenlabs.io/docs/api-reference/speech-engine) requires verification of the short-lived `X-Elevenlabs-Speech-Engine-Authorization` JWT.
- **Music detailed SSE:** `POST /v1/music/detailed/stream` is REST initiation with a streaming SSE response and needs protocol-aware event handling.

The current `elv ws` catalog includes TTS, TTS Multi-Context, realtime STT, and Agent conversations. It also accepts arbitrary WebSocket URLs. It does not model monitoring as a named catalog entry, and its outbound scripted client is not the correct architecture for hosting Speech Engine's inbound upstream protocol.

## Public API versus ElevenCreative product/UI surface

The official documentation index currently describes ElevenCreative product areas including Image & Video, Avatars, Ads Engine, Assets, Flows, Templates, Music Finetunes, Transcript Editor, Subtitle Editor, and other UI workflows. Those areas are not represented as public paths in the live OpenAPI document or as public API-reference entries in the official API index retrieved on 2026-07-16.

Confirmed fact: these are documented ElevenLabs product capabilities.

Inference for CLI scope: they should be classified as product/UI-only or not-yet-public API surfaces until ElevenLabs publishes stable HTTP/AsyncAPI contracts. "Cover the entire API" should mean the published OpenAPI and AsyncAPI surfaces, not screen automation or guessed private endpoints.

## Current CLI coverage and concrete gaps

### Already covered

- **Live REST discovery:** a real `ELV_CACHE_DIR=<temp> npx tsx src/cli.ts spec update` compiled 338 operations from the live spec and exposed `compose_detailed_stream` through `ops get`.
- **Generic REST calls:** `elv call` covers compiled operations; `elv http` covers arbitrary paths.
- **Arbitrary models:** TTS, STT, music, sound effects, and voice-change aliases pass through model IDs rather than hard-coding an allowlist.
- **Binary/large-output safety:** existing response normalization already saves audio and large payloads to disk.
- **Common WebSockets:** the four most common public client-side channels are cataloged, with arbitrary URL escape hatch support.

### Confirmed gaps or stale surfaces

1. **Vendored snapshot is stale:** offline discovery is 19 operations behind the live spec.
2. **README count is nominal, not callable:** it says 320 operations, while the baseline compiler intentionally exposes 319 because one deprecated route is skipped. The same distinction is now 339 documented versus 338 compiled.
3. **Deprecated alias:** `elv agents simulate` calls `run_conversation_simulation_route`, newly deprecated upstream.
4. **Music alias is narrow:** it covers only `generate` and `stream_compose`; it does not expose detailed response, detailed SSE, composition plans, upload, stem separation, or video-to-music ergonomically.
5. **Music detailed SSE is saved raw:** the live operation compiles as `streamKind: "text"`. The CLI saves `text/event-stream` to a file but does not decode event envelopes or audio chunks.
6. **Dubbing alias targets the older general dub flow:** it does not expose the 15 new `/v1/dubbing/project...` transcript-editing operations.
7. **Agent alias is a thin subset:** it does not expose tests, branches, tools/MCP, knowledge-base RAG queries, service integrations, analytics, or other major Agents Platform areas as aliases. They remain reachable through `call`.
8. **Workspace administration has no curated alias:** service accounts and members are generic `call` operations only.
9. **WebSocket catalog is incomplete:** no named monitoring entry; Speech Engine requires a separate inbound-server concept rather than another catalog URL.
10. **Model-list wording can mislead:** `/v1/models` is not an exhaustive cross-product model catalog.

## Facts versus open questions

### Confirmed

- Live REST surface: 339 documented / 338 compiled operations.
- Exact 19-operation delta listed above; zero removed operation IDs.
- Music detailed SSE, simulation deprecation, interruption-mode migration, service-account creation, member listing, `run_subagent`, nested transfers, sentiment changes, and agent TTS latency-setting deprecation.
- 15 new Dubbing Project operations and one agent RAG query operation are present in the official live OpenAPI.
- No new post-baseline model launch was identified.

### Open questions / do not overclaim

- Whether all accounts can use the new Dubbing Project and agent RAG query routes, and whether ElevenLabs considers them beta or generally available.
- Whether the new Dubbing Project API is the formal replacement for every deprecated Dubbing Resource route.
- Whether the SDK's “multi-context text-to-dialogue WebSocket message types” note corresponds to a forthcoming public endpoint or only shared internal/generated types.
- Whether the announced July 9 removal of v1 TTS models is being staged by account or was delayed.
- Whether UI-only ElevenCreative features will receive public APIs. No public contracts were found, so private endpoint reverse engineering is not justified.
