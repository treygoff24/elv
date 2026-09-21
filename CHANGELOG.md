# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-09-21

### Security

- Implicit project config cannot select credential variables or redirect the endpoint. Project budgets may lower trusted ceilings, not raise them. Explicit `ELV_CONFIG`, environment, and flag overrides retain user authority.

### Fixed

- Polling deadlines cover the first HTTP request and cancel it. Child waits reject late success, cap output, preserve UTF8, and clean up owned process groups.
- Retry response classification has a total body-read deadline and bounded disposal before backoff. Final response bodies remain available to callers.
- `--wait` no longer issues one extra poll when sleeping consumes the whole deadline budget, including timer/clock millisecond rounding at the boundary. Timeout envelopes are unchanged.
- Stream fixtures pass on Node 26.9. This is a test-only compatibility fix with no runtime behavior change.
- File-emitting operations now check `--out`, `--save-json`, or the configured default output directory before dry-run, confirmation, budget checks, or network access. An unwritable target returns `invalid_out_target`, exit 2, no retry, and a runnable replacement-target hint instead of completing a paid call and then losing its output with exit 7.
- Error envelopes now carry runnable recovery hints for every exit code from 2 through 9. Raw HTTP errors use `elv http --help`; confirmation hints replay a body-only alias or build a canonical `elv call ... --dry-run` with path and query input; auth hints use `elv config doctor --online` and honor profile `api_key_env`; budget and credit errors point to `elv usage`; unknown commands fall back to the nearest applicable `--help`.
- `speech_to_text`, whether invoked through `stt` or `elv call`, now requires exactly one media source: a local file (`stt --file PATH` or `--file file=PATH`), `body.source_url`, or `body.cloud_storage_url`. Invalid combinations fail during dry-run with exit 2 and runnable hints before network access, and multipart `ops schema --example` output includes the required `--file <field>=./path/to/file` argument.

### Changed

- Config and cache paths honor absolute XDG roots. New output defaults to the XDG data directory instead of the cache; existing files are not moved.
- `spec status` verifies vendored metadata without recompiling the spec. Commands reuse one registry snapshot, including raw HTTP validation.
- NDJSON `view` retains only the requested preview while scanning all records for malformed input and credentials. Paginated `--all` output streams to collision-safe files.
- Tests default to two workers, configurable by environment. CI adds Linux Node 26; bin-symlink tests no longer rebuild shared output.
- Upstream removed `convai_coaching_proposals` from `WorkspaceResourceType` and added `dubbing_project` without notice. The CLI passes this enum through, so callers using the removed value now fail validation.
- Upstream deprecated crawl `max_depth`; it is now a no-op and will be removed in a future provider revision.
- Published conversation-history filters no longer document `neq`, `in`, `exists`, or `missing`. The server still accepted them in a September 21, 2026 probe, but callers should treat them as unsupported going forward. Replace `missing` with an empty value, which matches conversations where the field was not collected.
- New model IDs remain passthrough strings: batch-only `scribe_v2_medical` for `POST /v1/speech-to-text` at the Scribe v2 price, `music_v2_5` as the product default, `gpt-image-2.5-flare` and `gpt-image-2.5-sunburst` for `flows image`, and agent LLMs `gemini-3.8-flash` and `gpt-6-astra`. The API's `MusicModelID` default remains `music_v1`, so select `music_v2_5` explicitly.

### Added

- Offline Node transport guards, production-only packed-install smoke, and local runtime/skill verification. Skill sync refuses dirty/unknown targets and symlink escapes, preserves foreign files, and verifies afterward.
- Refreshed the September 21, 2026 public API snapshot to 302 paths, 391 documented operations, 390 callable operations, one skipped operation, and 1,524 schemas. The three new operations are `post_agent_hold_audio_route`, `delete_agent_hold_audio_route`, and `list_phone_numbers_page_route`; the paged phone-number list is available through `elv call` and its generic paginator clamps page size to 1,000.
- Added `agents hold-audio upload|delete`. Upload accepts MP3 or WAV clips up to 40 MB and 180 seconds and replaces the existing clip; delete restores the default tone and, as a destructive action, requires `--yes`.
- Added `--search` to `agents test-runs list`; both agent test list routes describe it as filtering tests and folders by name.
- Added `--max-documents-length` (1-50000) and `--max-retrieved-rag-chunks-count` (1-20) to `agents rag-query`.
- The `ws convai` catalog documents `queue_status` values `waiting`, `admitted`, and `timed_out`, plus `agent_response.attachments`. After a peer-initiated close, the envelope's `ws` information and session manifest may carry `close_code` and `close_reason`, plus `close_code_name` when the catalog names the code; CLI timeout and EOF teardown leave those fields absent. Code 4300 maps to `queue_timeout`, adds a `ws_queue_timeout` warning, and hints `elv agents get --agent-id <id>`.
- `ops search` resolves intent phrases such as "make speech," "synthesize speech," "transcribe," "isolate vocals," and "dub" toward their canonical operations, ranks current operations ahead of deprecated ties, and hints `elv voices clone-instant` for "clone voice."
- `capabilities` reports `spec.spec_age_days` and emits `spec_check_stale` when the pinned snapshot reaches 90 days old. The warning says to upgrade the package; hints name `npm install -g eleven-agent-cli@latest` first and the network-dependent `elv spec diff` second.
- `elv spec update --from <file>` records the local file's modification time as `retrieved_at` instead of the time the command ran.
- `spec status` includes `active_differs_from_vendored_description` to clarify that the flag compares the active local cache with the vendored snapshot, not with the provider's current spec.

## [0.4.0] - 2026-09-06

### Added

- Refreshed the public API snapshot: 388 documented operations, 387 callable, 300 paths, and 1,507 schemas. Added Flows image/video/speech and Assets aliases, all ten Agents triage-ticket operations, and conversation summaries. Flows creation supports `--wait`.
- Added Text-to-Dialogue single/multi-context WebSockets, separate audio files per context, and environment-sourced WebSocket tokens and signed URLs.
- Added opt-in duplex WebSockets for every catalog protocol and raw targets: live NDJSON actions on stdin, redacted events on stderr, and one final stdout envelope. This supports live synthesis/transcription and responses to server-generated tool-call IDs, with shared incremental protocol validation.
- Added explicit REST query-array flags such as `--query 'sources[]=qa'`.
- `flows`, `stt`, and `dubbing` `--wait` accept `--interval-ms` and `--timeout-ms`; a `wait_timeout` envelope now names the deadline and carries hints for re-polling the created id instead of resubmitting a paid job. Poll bounds are validated before the create request.
- `elv ws --list` reports each route's duplex support, first message, and terminal rule, and WebSocket input errors carry hints naming the next command. `elv capabilities` reports the pinned spec's source URL and retrieval date.

### Fixed

- Validates known path/query/header schemas before network access while preserving valid union values and leaving request-body JSON uncoerced. Raw HTTP uses one canonical query representation; duplicate scalar parameters fail instead of being silently discarded.
- Generated examples preserve union/array request bodies, discriminator constants, referenced parameter enums, and shell quoting.
- Agents WebSockets now preserve `agent_id`, acknowledge nested pings correctly, and decode nested audio events. Known absolute WebSocket paths inherit safety and budget metadata without forwarding profile credentials to arbitrary hosts.
- Signed media URLs stay in private artifacts while redacted metadata supports polling, pagination, projection, and `view`. Failed later pages retain earlier private artifact paths.
- Automatic pagination sizes respect published provider maxima.
- `stt --wait` preserves completed synchronous transcripts and stops polling on actual transcript responses. STT/Dubbing dry-runs no longer poll, and missing-ID errors retain creation receipts.
- Music's non-streaming detailed response now yields separate audio and JSON metadata files instead of an opaque multipart blob, with partial recovery on malformed or interrupted responses.
- Output publication is atomic and never replaces occupied files, including modified collision targets and symlinks. Concurrent results return their actual distinct paths. Sensitive outputs retain explicit filename markers, including caller-named destinations; prior files and permissions remain unchanged.
- Malformed successful JSON and opaque credential responses are preserved privately instead of leaking parse previews. `view` refuses marked private files before parsing, including binary and collision-suffixed files.
- Encoded HTTP/WebSocket paths inherit the same safety metadata as the routes the provider decodes; path values are decoded only once. TTS single/multi-context terminal rules now match their distinct protocols.
- WAV timestamp responses and requested A-law/WAV WebSocket files retain the appropriate extensions. Multi-file output targets are checked before generation.
- Duplex WebSocket events are written synchronously to stderr, so a slow consumer no longer loses buffered events when the process exits. An explicit close after a terminal message is accepted, a close inside a `--send` seed under `--duplex` is rejected before connecting, input errors are no longer masked by a concurrent remote close, received binary frames are reported as events, and a non-string `context_id` falls back to the default audio writer with a warning.
- `--token-env` is refused for any host other than the configured API host, so a single-use token can never be forwarded to an arbitrary WebSocket URL; foreign hosts also no longer get a catalog label while still inheriting path-matched safety metadata. Agent audio without a declared `output_format` is saved as `audio.bin` with a `ws_audio_format_unknown` warning instead of a misleading `.mp3`.
- Output publication falls back to exclusive create where hard links are unsupported (exFAT, FAT32, SMB, some FUSE mounts) while still never replacing an existing file; unusable `--out` targets report `invalid_out_target` with a hint, including from multipart responses.
- Inline media responses strip every URL query string, including CloudFront `Signature` and `Key-Pair-Id`, so undocumented signed sibling URLs cannot leak beside the private file. Caller-named sensitive binary targets no longer double the `.sensitive.bin` marker.
- A `--limit` above the provider's page-size maximum reports a `page_size_clamped` warning. Generated `ops schema --example` commands emit `--file` for multipart file fields. Documentation count checks are bound to the pinned snapshot metadata and verify its digest.

### Changed

- Realtime STT file scripts use `send_audio_file` to emit the published JSON audio-chunk protocol; `send_binary_file` is reserved for unknown raw protocols.
- `config doctor` is offline by default. `--online` opts into provider checks, which refuse redirects.
- WebSocket protocol rules (cost model, token parameter, v3 rejection, default audio format) live in the catalog rather than in command-level switch tables. The OpenAPI validation engine is built lazily on first use, and multipart metadata is collected in chunks instead of a 2 MiB preallocation.
- Updated the transitive `fast-uri` dependency to resolve its published security advisories.
- Refreshed locked production dependencies and verified the installed dependency tree against them.
- OpenAPI compilation now rejects nested external references before bundling, preventing provider documents from reading local files or fetching arbitrary URLs. Explicit local JSON sources and recursive internal references remain supported; multi-file specs require prebundling.

### Removed

- Removed the no-op `call --unpack` flag. ZIP responses still download intact; the CLI no longer advertises extraction it never performed.
- Speech Engine upstream hosting and the WebRTC client transport were built during this cycle and removed before release: hosting is a long-running server whose wire protocol is absent from the published contract and which needs a public TLS endpoint the CLI does not provide, and WebRTC duplicated the `convai` WebSocket while adding a native dependency. The Speech Engine REST lifecycle and `get_livekit_token` remain available through `call`.

## [0.3.0] - 2026-08-11

### Added

- Refreshed the vendored ElevenLabs OpenAPI document to the August 11, 2026 revision: 364 documented operations, 363 callable operations, 285 paths, and 1,402 schemas at SHA-256 `d1a4847203cef628b0c43760b0c74ecd88fa280034bb47c973874ae911f6153a`. New coverage includes eight Agents Procedures operations, Dubbing v2 bulk source/target transcript updates, voice accents, and cross-residency voice replication.
- Added `music finetunes` lifecycle aliases and `--finetune-id` to regular, streaming, and detailed Music generation.
- Added configured STT webhook delivery through `--webhook [--webhook-id ID]` and env-sourced single-use tokens through `--token-env ENV_NAME`.
- Added `agents procedures`, Dubbing v2 atomic `update-segments`, and `voices accents|replicate` aliases over the refreshed contract.
- Documented realtime STT `entity_detection` through arbitrary WebSocket `--query` fields, Dubbing v2 transcript editing, and the published Procedures and voice-replication surfaces.
- Rebuilt the shipped `elv` skill around a checkable execution loop, with branch-specific references for discovery and generic calls, media workflows, and agents/workspace/WebSockets.

### Fixed

- Bare parent commands such as `elv voices` now return a help success envelope and exit 0 instead of treating discovery as validation failure.
- `elv spec status --offline` is accepted as a no-op compatibility flag, matching the other `spec` subcommands.
- Generated `ops schema --example` commands now populate required shaped arrays and nested required object fields instead of emitting invalid empty placeholders.
- Binary `text/csv` responses, including batch-call export, spill to `.csv` files and are never returned inline as `data`.
- Rejected the obsolete `stt --webhook <url>` form with an actionable migration message instead of sending a URL in the provider's boolean `webhook` field.
- Classified crawl cancellation and the July 27 bulk knowledge-base delete route as destructive because they delete associated knowledge-base documents or folders. Classified the July 27 bulk dependent-agent lookup as read-only despite its POST method.
- Classified cross-residency voice replication as an external side effect so `call`, matching raw `http`, and aliases require `--yes`; Procedure DELETE operations remain destructive by method.
- Classified Dubbing target-transcript regeneration as generation so a configured credit ceiling fails closed when the provider's charge cannot be estimated.
- Made `spec diff` stable after an active registry cache round trip instead of reporting every operation changed when JSON serialization omitted undefined fields.
- Added an npm `prepack` build so normal `npm pack` and `npm publish` runs rebuild `dist/cli.js` before assembling the tarball, including from clean checkouts.
- Scoped Vitest discovery to the tracked `tests/` tree so ignored agent scratch directories cannot duplicate the suite or exhaust local resources.

### Security

- Updated the transitive production dependencies `fast-uri` and `js-yaml`, plus the development-only `nanoid` and `postcss`, to patched releases; both full and production-only `npm audit` checks now report zero vulnerabilities.

## [0.2.0] - 2026-07-16

### Added

- Refreshed the vendored ElevenLabs OpenAPI document to the July 16, 2026 revision: 339 documented operations, 338 callable operations, 268 paths, and 1,345 schemas at SHA-256 `de0476611805f3ee4e6a6c76dcdd6cc9686b8daee5757e6465d2974094c844ce`.
- Added `elv capabilities`, filtered `ops list`, deprecation warnings, and `spec status` / `spec diff`. Spec updates now compile before atomically replacing one authoritative bundled-spec, registry, and provenance cache.
- Added `music detailed-stream`, which decodes Music SSE audio, writes metadata as NDJSON, and preserves valid partial output after malformed events.
- Added aliases for agent tests and test runs, read-only agent RAG diagnostics, workspace members and service accounts, and Dubbing Project source and target transcript editing.
- Added `convai-monitor` to the WebSocket catalog, binary file sends for realtime STT, protocol-specific script validation, and WebSocket `--dry-run`, `--yes`, `--max-credits`, profile, residency, and configured-model behavior.
- Added file-only handling for credential-producing responses. Tokens, signed URLs, API keys, and similar values are written to mode `0600` files marked `sensitive: true`; `elv view` refuses to render them.

### Security

- The API client and the spec fetcher refuse cross-origin redirects, so `xi-api-key` and spec contents never follow a redirect to another host. Same-origin redirects are followed manually with a hop limit.
- `elv view` refuses `*.sensitive.json` spill files by name in addition to credential-content detection.
- With a credit ceiling configured, unmatched raw HTTP writes and other unboundable spending operations now fail pre-flight unless `--yes` explicitly accepts the unbounded-cost risk.
- The registry cache self-heals: cache validity is fingerprinted over the spec source bytes, the risk/cost curation tables, and the compiler's own semantics, so stale safety metadata can never survive a same-version change.

### Changed

- Stream failures distinguish transport interruption (`network_error` / `stream_interrupted`) from malformed framing; partial output is preserved in both cases and retries are never auto-recommended for paid generations.
- Multi-line SSE `data:` base64 audio decodes correctly; strict base64 validation otherwise unchanged. JSON-events streams now fail cleanly on invalid UTF-8 instead of silently corrupting output.
- `elv call` covers the compiled public REST document. Matching `elv http` requests inherit registry metadata; unmatched paths remain forward-compatible.
- Budget ceilings fail closed when generation or STT/agent WebSocket costs cannot be estimated. Other unknown costs report `unknown_unbounded`.
- `models list` is documented as the account-visible `/v1/models` response, not an exhaustive cross-product catalog. Examples now use `scribe_v2`; Turbo and Scribe v1 deprecations and current model families are documented.
- `agents simulate` now emits a deprecation warning. The preferred workflow is `agents tests create` followed by `agents tests run`.

### Scope

- Speech Engine upstream remains outside the outbound WebSocket client because ElevenLabs connects to a server hosted by the customer.
- ElevenCreative UI-only Image & Video, Avatars, Ads, Flows, and editor workflows have no published API contract in the pinned sources and are not reverse-engineered.

## [0.1.0] - 2026-07-06

### Added

- Initial agent-first ElevenLabs CLI over the ElevenLabs OpenAPI spec.
- Operation runner for the generated OpenAPI operation catalog.
- Twelve workflow aliases for common text to speech, speech to text, music, sound effect, voice, agent, history, usage, and discovery tasks.
- `http`, `ws`, and `wait` escape hatches for raw REST calls, scripted WebSocket sessions, and polling workflows.
- Operation discovery commands for search, details, schemas, and runnable examples.
- One-envelope command contract for success and error output.
- Safety model for `--yes`, `--max-credits`, and `--dry-run`.
- `elv view <path>` — inspect a spilled JSON/NDJSON result file without loading it into context, with an optional dotted `--path` (numeric array indices supported) and `--limit`. Small slices return inline; large ones return a `data_summary` plus a narrow-further hint. Spilled-result hints now point at this command.

- `--fields <csv>` on the list aliases (`voices list`, `history list`, `agents list`, `dubbing list`) — project each item in the result down to a comma-separated set of fields and return it inline. Turns the common "id + name for each voice" lookup from a 97 KB spill (or one call per row) into a single sub-KB envelope.

- `[]` array projection in the JSONPath reader, so `elv view <file> --path 'voices[].name'` returns a flat array of every item's field (and `voices[]` returns the array itself). Composes with nested paths, e.g. `voices[].fine_tuning.state`.

### Fixed

- CLI produced no output when run through its `bin` symlink (`npm link`, `npm install -g`, `npx`); the entrypoint guard now resolves symlinks on both sides so `main()` runs.
- Removed internal build-phase labels that leaked into user-facing output (the registry-cache warning and the not-implemented error).
- Voice-by-name resolution (`voices find`, `tts --voice`, `voice-change --voice`) returned nothing for built-in voices because the large `get_voices` response spilled to disk before the name match ran; resolver lookups now read it inline.
- `tts --timestamps` wrote raw JSON into the audio file (or, for short clips, dumped a base64 blob to stdout); it now decodes the audio to the output file and writes the alignment to a `*.timestamps.json` sidecar, keeping the envelope small.
- Voice cloning and other multipart uploads (`voices clone-instant`/`add_voice`, `add_pvc_voice_samples`, `edit_voice`, `request_pvc_manual_verification`, `video_to_music`) failed validation because array-of-binary file fields were not recognized; the field classifier and request validation now handle them.
- Per-command help (for example `elv tts --help`) returned the global command list instead of that command's own flags and arguments.
- The large-output hint advertised a nonexistent `elv view … --jq` command; spilled-result hints now point at the real `elv view <path>` command (see Added).
- The `cost_header_absent` warning fired on every read; it now appears only for operations that are expected to bill.
- `elv wait` required `--failure` even when only a success condition mattered; `--failure` is now optional.
- Paginated list responses large enough to spill to disk silently dropped the `next` page command and inline truncation, and `--all` could collect zero items because each spilled page hid its data and cursor; paginated fetches now normalize inline so pagination runs first, then a still-large page spills while keeping the small `next` cursor inline.
- `--limit` accepted `0`, negative, and fractional values, producing empty or malformed output; it is now validated as a positive integer before any request (exit 2).
- Spilled-result hint commands now shell-quote the file path and `--path` value so they are safe to copy-paste when a key or path contains shell metacharacters.
- `elv tts` and `elv voice-change` reported a missing `--voice`/`--voice-id` as a generic `internal_error` (exit 8) because the voice resolver threw before the command's `try`; missing required input is now a `validation_error` (exit 2), matching every other command.
- `elv view` no longer drops its "use cat to inspect raw contents" hint on a malformed JSON/NDJSON file (an extracted JSON helper had started throwing a plain error, making the hint branch unreachable).
- `config get` / `config doctor` again honor `ELV_DEBUG` when `--debug` is not passed (a boolean coercion had broken the environment-variable fallthrough).

### Changed

- The published package now ships the agent setup guide (`docs/`) and the bundled `elv` skill (`skills/`).
- Bumped `music-metadata` to v11; clone-and-build instructions now use `npm ci`.
- The default output directory moved from the working-directory-relative `./.elv/out` (which littered any repo you ran `elv` in) to `~/.cache/elv/out`; `--out`, `ELV_OUTPUT_DIR`, and a profile's `output_dir` still override it, and an extensionless `--out` path is now treated as a directory.
- Every command flag now carries a `--help` description, so `elv <command> --help` is self-documenting.
- `voices list` now uses the paginated `get_user_voices_v2` endpoint instead of v1 `get_voices` (which stopped working once a workspace exceeded 500 voices), and gained `--search` and `--sort`. Its `--limit` flag is meaningful again as the page size.
- The list aliases (`voices list`, `history list`, `agents list`, `dubbing list`) now support real pagination — `--limit` (page size and inline cap), `--all`, and `--save-json` — sharing the same framework as `call`/`http`.
- Voice-name resolution (`voices find`, `tts --voice`, `voice-change --voice`) now queries `get_user_voices_v2` with a server-side `search` (works past 500 voices) and resolves an exact name, or a unique substring match, instead of requiring an exact name.
- Bare `elv ops`, `elv config`, and `elv spec` now print their subcommands and exit 0 instead of returning a `not_implemented` provider error (exit 8).
- Bare `elv` (no command) now prints the command list and exits 0 instead of a `Missing command` validation error, and both it and the top-level `--help` now carry a tagline plus a one-line description per command. Every subcommand (including discovery leaves like `ops search` and `voices list`) now has its own `--help` description.
- `elv voices get` accepts the voice id as a positional argument (`elv voices get <id>`), matching `voices find <query>`; `--voice-id` still works as an alternative.
- Provider and runtime error envelopes now include actionable `hints[]` (for example `elv config doctor` on an auth failure, `elv voices list` on an unknown voice id, `elv usage` when out of credits).
- `elv http` now applies the same safety and budget gating as `elv call`: destructive/external operations require `--yes`, and `--max-credits` is enforced pre-flight. Previously raw HTTP calls ran ungated.
- Operation risk classification was tightened so more workspace-mutating operations (secrets, webhooks, MCP servers, auth connections, resource sharing, WhatsApp/Twilio config, etc.) require `--yes`. This only ever adds confirmation prompts; nothing that required `--yes` before is now ungated.
- Invalid `--max-credits` / `--limit` values (non-numeric, non-finite) are now rejected as `validation_error` (exit 2) instead of being silently ignored.
- A malformed local config file is now reported as a `validation_error` (exit 2) with a `config_json_invalid` code, instead of a generic internal error.

### Security

- Cleared all dependency advisories: `music-metadata` v11 resolves the transitive `file-type` infinite-loop, and `esbuild` is pinned to a patched 0.28.1. `npm audit` reports zero vulnerabilities.

### Removed

- Internal build specs (`specv1.md`, `specv2.md`) that should not ship in a public repo.
- The unused `notImplemented` error helper, dead once bare parent commands began printing help.
