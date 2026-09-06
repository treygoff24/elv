# API coverage

`elv` covers the published ElevenLabs REST API and the documented client-side realtime protocols. It does not claim that every ElevenLabs product screen has a public API.

## Pinned REST contract

The vendored OpenAPI document was retrieved from `https://api.elevenlabs.io/openapi.json` on September 6, 2026 at `2026-09-06T04:06:22Z`:

| Measure | Value |
| --- | ---: |
| SHA-256 | `587ca2ac585d793cbf210512806bfcdf78e6c4ee187fcd756bb25f764b8cfd39` |
| Paths | 300 |
| Documented operations | 388 |
| Callable operations | 387 |
| Skipped operations | 1 |
| Schemas | 1,507 |

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

Specs must be self-contained JSON. Internal fragment references remain supported,
including recursion. Nested file, relative-file, and remote references are rejected
before bundling; a provider document cannot cause arbitrary local reads or extra
network fetches. Prebundle multi-file documents before supplying them.

## Realtime and streaming

The named WebSocket catalog covers the public client-side protocols:

| Catalog name | Protocol |
| --- | --- |
| `tts-realtime` | Streaming text to speech |
| `tts-multi` | Multi-context streaming text to speech |
| `ttd-realtime` | Streaming text to dialogue with per-input voices |
| `ttd-multi` | Multi-context streaming text to dialogue |
| `stt-realtime` | Realtime speech to text, JSON audio-file chunks, and `entity_detection` |
| `convai` | ElevenAgents conversations |
| `convai-monitor` | Conversation text and metadata monitoring, with optional controls |

Validation follows the selected protocol. Dialogue initialization declares voices; subsequent `inputs` carry text and voice IDs. Its v3 model rules differ from older TTS WebSockets. STT `send_audio_file` actions emit the documented JSON `input_audio_chunk` frame; `send_binary_file` remains for raw sessions only. TTS and TTD multi-context audio goes to separate files, and per-context final messages do not end the whole connection. Agents ping/pong and audio use the provider's nested event shapes.

`--token-env` uses STT's `token` query parameter or TTS/TTD's `single_use_token`; `--url-env` accepts signed URLs without putting credentials in argv. Known absolute URL paths inherit protocol metadata but not profile authentication. Receive-only monitoring needs no send script; outbound agent and monitor actions require `--yes`. Credit ceilings bound scripted TTS/TTD text estimates and fail closed for STT/agent sessions. Unknown raw outbound costs require explicit consent with `--yes` when a ceiling is configured. `--dry-run` makes no connection.

Music detailed streaming begins as a REST request but returns Server-Sent Events. `elv music detailed-stream` decodes its audio chunks to an audio file and writes the remaining event data to NDJSON. Both appear in `files[]`.

## Model examples

| Area | Model IDs |
| --- | --- |
| Text to Speech | `eleven_v3`, `eleven_multilingual_v2`, `eleven_flash_v2_5`, `eleven_flash_v2` |
| Realtime dialogue | `eleven_v3_conversational`, `eleven_v3` |
| Text to Voice | `eleven_ttv_v3`, `eleven_multilingual_ttv_v2` |
| Speech to Speech | `eleven_multilingual_sts_v2`, `eleven_english_sts_v2` |
| Speech to Text | `scribe_v2`, `scribe_v2_realtime` |
| Sound Effects | `eleven_text_to_sound_v2` |
| Music | `music_v2`, `music_v1` |

ElevenLabs marks `eleven_turbo_v2_5`, `eleven_turbo_v2`, and `scribe_v1` deprecated and recommends `eleven_flash_v2_5`, `eleven_flash_v2`, and `scribe_v2` respectively.

`elv models list` returns the models visible to the authenticated account from `GET /v1/models`. That endpoint is not a complete product catalog: it may omit STT, realtime STT, Sound Effects, Text to Voice, Music, and other service-specific IDs. Model availability also varies by account, region, plan, entitlement, and rollout. Alias model arguments therefore pass through as strings rather than enforcing a stale global allowlist. A profile's `default_model_id` applies only to TTS REST and named TTS WebSocket calls when no model is supplied.

## Recent workflow coverage

The September 6 snapshot adds 24 operations relative to August 11: nine Flows generation operations, four Assets operations, ten Agents triage-ticket operations, and conversation summaries. No operation was removed. The runner compiles every non-skipped operation, and every request-body schema can be compiled by the local validator. This checks the published contract, not account entitlements or live execution of every operation.

`flows image|video|speech` supports create, list, and get; `create --wait` polls until completion or failure. `assets` supports upload, list, get, and delete. `agents tickets` supports both agent and workspace lists, creation from conversations or manual creation, assignment discovery, updates, deletion, and ticket/turn comments. `agents conversations summary` reads summaries. Model-specific generation options remain available through alias body JSON or generic calls.

Current high-use workflow coverage includes:

- `music detailed-stream` for Music SSE audio and metadata
- `music finetunes` for listing, training, inspecting, updating, and deleting Music Finetunes; every Music generation alias accepts `--finetune-id`
- `stt --webhook [--webhook-id ID]` for configured webhook delivery and `--token-env ENV_NAME` for a single-use Scribe token
- `agents tests` and `agents test-runs` for the preferred testing workflow
- `agents rag-query` for read-only knowledge-base retrieval diagnostics
- `workspace members` and `workspace service-accounts`
- Dubbing v2 source/target transcript editing and changed-segment regeneration through `dubbing-project`
- Agents Procedures through `agents procedures`, Dubbing v2 bulk updates through `dubbing-project ... update-segments`, and voice accents/replication through `voices accents|replicate`

`agents simulate` remains for compatibility but invokes an operation ElevenLabs marks deprecated. Use `agents tests create` and `agents tests run` for new work.

Credential-producing responses, including service-account keys, single-use tokens, and signed URLs, never return the secret inline. `elv` writes the response to a mode `0600` file, marks it `sensitive: true`, and refuses to display it through `elv view`. Flows and Assets also retain redacted metadata inline so status polling, field projection, and pagination work. `--all` retains each private page artifact alongside the combined redacted collection.

## Coverage boundaries

Speech Engine upstream is a published inverted protocol. `speech-engine serve` hosts an authenticated local endpoint and bridges transcript turns to a subprocess handler. It verifies the provider's HS256 token contract before accepting a WebSocket; this contract is grounded in the [official SDK verifier](https://github.com/elevenlabs/elevenlabs-js/blob/aa6976916c3c4a7dec5db572c03eed0b56d6b8fc/src/wrapper/speech-engine/SpeechEngineResource.ts). The REST lifecycle remains available through `call`. Hosting does not automatically create resources, open tunnels, deploy TLS, or start paid conversations. Mock clients verify authentication and protocol behavior; a live ElevenLabs-hosted conversation has not been exercised by the offline gate.

Duplex stdin/stderr sessions support every catalog protocol and raw WebSockets. A shared incremental validator applies the same message and context rules to finite scripts and live input without retaining unbounded action history. Dynamic speech/dialogue/transcription/conversation costs fail closed under a configured ceiling. EOF closes transport; callers should send protocol flush/end controls and await final events first. Account, region, enterprise, and beta entitlements remain separate from CLI support.

Flows Image & Video, speech generation, and Assets are now public and included. Other editor screens are not evidence of a public API contract; `elv` does not reverse-engineer private endpoints. Provider entitlement can still limit access to published operations.

Public docs, beta and enterprise entitlements, server behavior, and the live OpenAPI document can change independently. `elv spec diff` is the check for current REST drift; the pinned counts above are a reproducible baseline, not a claim about unpublished backend capabilities.
