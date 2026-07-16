# API coverage

`elv` covers the published ElevenLabs REST API and the documented client-side realtime protocols. It does not claim that every ElevenLabs product screen has a public API.

## Pinned REST contract

The vendored OpenAPI document was retrieved from `https://api.elevenlabs.io/openapi.json` on July 16, 2026:

| Measure | Value |
| --- | ---: |
| SHA-256 | `de0476611805f3ee4e6a6c76dcdd6cc9686b8daee5757e6465d2974094c844ce` |
| Paths | 268 |
| Documented operations | 339 |
| Callable operations | 338 |
| Skipped operations | 1 |
| Schemas | 1,345 |

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
| `stt-realtime` | Realtime speech to text, including binary file sends |
| `convai` | ElevenAgents conversations |
| `convai-monitor` | Conversation text and metadata monitoring, with optional controls |

Validation follows the selected protocol. The TTS keep-alive is not imposed on STT or agent traffic, binary file actions are limited to STT and raw sessions, and WebSocket TTS rejects `eleven_v3`. Receive-only monitoring needs no send script, while outbound agent and monitor actions require `--yes`. WebSocket `--max-credits` can bound scripted TTS from its text but fails closed for STT and agent sessions whose cost is not knowable before connection. `--dry-run` shows the resolved, redacted request and applicable gates without connecting.

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

The generic runner covers every new operation in the pinned document. The high-use additions also have aliases:

- `music detailed-stream` for Music SSE audio and metadata
- `agents tests` and `agents test-runs` for the preferred testing workflow
- `agents rag-query` for read-only knowledge-base retrieval diagnostics
- `workspace members` and `workspace service-accounts`
- `dubbing-project transcript` and `dubbing-project target-transcript`

`agents simulate` remains for compatibility but invokes an operation ElevenLabs marks deprecated. Use `agents tests create` and `agents tests run` for new work.

Credential-producing responses, including service-account keys, single-use tokens, and signed URLs, never return the secret inline. `elv` writes the response to a mode `0600` file, marks it `sensitive: true`, and refuses to display it through `elv view`.

## Deliberate exclusions

Speech Engine upstream is an inverted protocol: ElevenLabs opens a WebSocket connection to a server the customer hosts. An outbound scripted CLI is the wrong runtime shape, so it is not a named `elv ws` target. The REST operations that configure Speech Engine resources remain available through `call`.

ElevenCreative product areas such as Image & Video, Avatars, Ads, Assets, Flows, Templates, Music Finetunes, and the transcript or subtitle editors were visible as UI products but not as published paths in the pinned OpenAPI document or public API index. `elv` does not reverse-engineer private endpoints. Add those areas when ElevenLabs publishes a stable API contract.

Public docs, beta and enterprise entitlements, server behavior, and the live OpenAPI document can change independently. `elv spec diff` is the check for current REST drift; the pinned counts above are a reproducible baseline, not a claim about unpublished backend capabilities.
