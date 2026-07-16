# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
