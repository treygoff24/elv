# API coverage

`elv` covers the published ElevenLabs REST API and the documented client-side realtime protocols. It does not claim that every ElevenLabs product screen has a public API.

## Pinned REST contract

The vendored OpenAPI document was retrieved from `https://api.elevenlabs.io/openapi.json` on August 17, 2026 at `2026-08-17T14:46:37Z`:

| Measure | Value |
| --- | ---: |
| SHA-256 | `c4bcaa50752fa4cc61d4e9fecdada4f387ce429b55b1eae7e1bda7e756748f06` |
| Paths | 294 |
| Documented operations | 378 |
| Callable operations | 377 |
| Skipped operations | 1 |
| Schemas | 1,452 |

The skipped operation is `get_signed_url_deprecated`, an obsolete route marked `x-skip-spec` by the source document. Its replacement, `get_conversation_signed_link`, is callable.

`elv call <operation_id>` reaches every compiled operation. `elv http <method> <path>` handles published REST endpoints newer than the pinned document; when a method and path match the registry, it inherits the operation's risk, cost, stream, deprecation, and secret-result metadata.

Use these commands rather than relying on a prose inventory:

```bash
elv capabilities
elv ops list --limit 100
elv ops list --deprecated
elv spec status
elv spec diff
```

`spec diff` compiles a candidate and reports operation and deprecation drift without writing it. `spec update` atomically replaces one authoritative cache envelope containing the bundled spec, operation registry, and provenance only after compilation succeeds.

## Realtime and streaming

The named WebSocket catalog covers the public client-side protocols:

| Catalog name | Protocol |
| --- | --- |
| `tts-realtime` | Streaming text to speech |
| `tts-multi` | Multi-context streaming text to speech |
| `stt-realtime` | Realtime speech to text, including binary file sends and `entity_detection` |
| `convai` | ElevenAgents conversations |
| `convai-monitor` | Conversation text and metadata monitoring, with optional controls |

Validation follows the selected protocol. The TTS keep-alive is not imposed on STT or agent traffic, binary file actions are limited to STT and raw sessions, and WebSocket TTS rejects `eleven_v3`. Named sessions forward arbitrary repeated `--query key=value` fields, so realtime STT `entity_detection` is available as `--query entity_detection=true` without a protocol-specific flag. Receive-only monitoring needs no send script, while outbound agent and monitor actions require `--yes`. WebSocket `--max-credits` can bound scripted TTS from its text but fails closed for STT and agent sessions whose cost is not knowable before connection. `--dry-run` shows the resolved, redacted request and applicable gates without connecting.

Music detailed streaming begins as a REST request but returns Server-Sent Events. `elv music detailed-stream` decodes its audio chunks to an audio file and writes the remaining event data to NDJSON. Both appear in `files[]`.

## Models documented July 16, 2026

| Area | Model IDs |
| --- | --- |
| Text to Speech | `eleven_v3`, `eleven_multilingual_v2`, `eleven_flash_v2_5`, `eleven_flash_v2` |
| Text to Voice | `eleven_ttv_v3`, `eleven_multilingual_ttv_v2` |
| Speech to Speech | `eleven_multilingual_sts_v2`, `eleven_english_sts_v2` |
| Speech to Text | `scribe_v2`, `scribe_v2_realtime` |
| Sound Effects | `eleven_text_to_sound_v2` |
| Music | `music_v2`, `music_v1` |

ElevenLabs marks `eleven_turbo_v2_5`, `eleven_turbo_v2`, and `scribe_v1` deprecated and recommends `eleven_flash_v2_5`, `eleven_flash_v2`, and `scribe_v2` respectively.

`elv models list` returns the models visible to the authenticated account from `GET /v1/models`. That endpoint is not a complete product catalog: it may omit STT, realtime STT, Sound Effects, Text to Voice, Music, and other service-specific IDs. Model availability also varies by account, region, plan, entitlement, and rollout. Alias model arguments therefore pass through as strings rather than enforcing a stale global allowlist. A profile's `default_model_id` applies only to TTS REST and named TTS WebSocket calls when no model is supplied.

## Recent workflow coverage

The generic runner covers every operation in the pinned document. August 17 adds four Assets operations, three-operation Image, Video, and asynchronous TTS Flows families, and `get_conversation_summary_route`. It also adds cursor pagination and sorting to Agents topics, a 25-item `agent_ids` filter to live-count analytics, the `flows` workspace-webhook event, and current model/configuration enums. The singular live-count `agent_id` remains valid; `agent_ids` takes precedence when both are supplied.

The three Flows create operations are centrally classified as generation. Async
TTS uses the existing character estimate. Image and video lack a defensible
published estimate, so a configured credit ceiling fails closed before network
access; without a ceiling, generation follows the existing ungated generation
policy. Asset upload remains an unpriced mutation and follows the existing
unknown-unbounded consent path when a ceiling is configured.

Current high-use workflow coverage includes:

- `music detailed-stream` for Music SSE audio and metadata
- `music finetunes` for listing, training, inspecting, updating, and deleting Music Finetunes; every Music generation alias accepts `--finetune-id`
- `stt --webhook [--webhook-id ID]` for configured webhook delivery and `--token-env ENV_NAME` for a single-use Scribe token
- `agents tests` and `agents test-runs` for the preferred testing workflow
- `agents rag-query` for read-only knowledge-base retrieval diagnostics
- `agents conversations summary` for a bounded summary and optional inline message window
- `assets` for multipart upload, search/list, get, and confirmed deletion
- `flows image|video|speech` for JSON-first create, get, list, and optional status polling
- `workspace members` and `workspace service-accounts`
- Dubbing v2 source/target transcript editing and changed-segment regeneration through `dubbing-project`
- Agents Procedures through `agents procedures`, Dubbing v2 bulk updates through `dubbing-project ... update-segments`, and voice accents/replication through `voices accents|replicate`

`agents simulate` remains for compatibility but invokes an operation ElevenLabs marks deprecated. Use `agents tests create` and `agents tests run` for new work.

Credential-producing responses, including service-account keys, single-use tokens, and signed URLs, never return the secret inline. `elv` writes the response to a mode `0600` file, marks it `sensitive: true`, and refuses to display it through `elv view`. For dynamically detected fields such as Asset and Flows `content_url`, the envelope also retains a structurally intact redacted `data` copy so pagination, projections, and status polling do not silently lose their control fields.

## Deliberate exclusions

Speech Engine upstream is an inverted protocol: ElevenLabs opens a WebSocket connection to a server the customer hosts. An outbound scripted CLI is the wrong runtime shape, so it is not a named `elv ws` target. The REST operations that configure Speech Engine resources remain available through `call`.

Assets and beta Image, Video, and asynchronous TTS Flows are present in the published OpenAPI document and compiled. Provider plan, model, entitlement, and regional restrictions can still limit access. Avatars, Ads, Templates, and other private editor workflows remain outside the published contract; `elv` does not reverse-engineer them.

Additional intentional non-goals:

- No hosted webhook receiver: `elv` can create/update/list webhook configuration and pass callback URLs/tokens where the API accepts them, but it does not run an internet-reachable webhook service for the user.
- No automatic signed-content download: signed URLs and other credential-bearing response fields are redacted from envelopes and saved as sensitive `0600` artifacts for explicit handling; the CLI will not silently fetch those URLs into prompts or ordinary JSON outputs.
- No handwritten typed flags for beta polymorphic unions: beta media/Flows request bodies stay registry/JSON-driven because model-specific union variants and const discriminators are changing quickly. `elv ops schema --example` remains the source-backed skeleton, and aliases keep a thin JSON pass-through until those contracts stabilize.

Public docs, beta and enterprise entitlements, server behavior, and the live OpenAPI document can change independently. `elv spec diff` is the check for current REST drift; the pinned counts above are a reproducible baseline, not a claim about unpublished backend capabilities.
