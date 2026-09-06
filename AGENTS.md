# elv agent usage

Agent-first ElevenLabs CLI. Branch on exit code first; parse the envelope when you need details.

## Working in this repo

This file ships in the npm tarball (`files` in `package.json`), so everything below is user-facing documentation, not scratch notes — keep repo-internal state out of it. The published package is `eleven-agent-cli`; the binary it installs is `elv`.

The canonical gate is `npm run gate` (`scripts/gate.sh`). It runs, fail-fast:

```bash
npm run format:check   # oxfmt — NOT prettier
npm run lint           # oxlint — NOT eslint; it rejects eslint-era flags such as --no-cache
npm run typecheck      # tsc --noEmit
npm run build          # tsup -> dist/cli.js
npm run test           # vitest run
npm run smoke          # offline envelope matrix against the built dist/cli.js
```

Run `npm run gate` before and after a change. Never reach for `npx prettier` or `npx eslint`: they are not installed here and will fetch a foreign formatter that rewrites touched TypeScript with incompatible wrapping. `npm run format` (no `--check`) is the only rewriter. Lint one path with `npx oxlint src/cli.ts`; oxlint has no `--no-cache`.

`npm run smoke` runs the offline JSON-envelope matrix in `scripts/smoke-matrix.tsv` — a fast contract check that every listed command still prints one `v:1` envelope with the documented exit code, no network and no credits. Point it at any build with `ELV_BIN="$(command -v elv)" npm run smoke`. `npm run smoke:pack` does the same against an unpacked `npm pack` tarball, staging the repo's `node_modules` so no network install is needed.

`dist/cli.js` is what an installed `elv` actually executes (`npm link` symlinks the global bin at it), so **a source fix is not live until you rebuild**. `npm run build` is the reinstall. Verify the installed runtime, not just the source tree: `elv --version`, then `ELV_BIN="$(command -v elv)" npm run smoke`.

Searching: `spec/openapi.snapshot.json` is one ~1.8 MB line, so a broad `rg` or `git grep` that hits it floods and truncates the output you wanted. A checked-in `.ignore` keeps ripgrep out of it and `.gitattributes` marks it binary for git. Search it on purpose with `rg --no-ignore <pattern> spec/openapi.snapshot.json`, or better, use `elv ops search` / `elv ops get` / `elv ops schema`. `src/commands/aliases/README.md` maps that directory; the shared helper is `shared.ts`.

## One envelope per command

Stdout is always a single `SuccessEnvelope` or `ErrorEnvelope` (`v: 1`, `ok: true|false`). Binary and large payloads go to disk; paths appear in `files[]`. Never expect human prose, spinners, or multiple JSON lines.

## Exit codes

| Code | Meaning                                                     |
| ---- | ----------------------------------------------------------- |
| 0    | Success                                                     |
| 2    | Input / validation                                          |
| 3    | Auth / permission                                           |
| 4    | Confirmation required: add `--yes`                         |
| 5    | Budget ceiling: raise `--max-credits` or lower the op cost |
| 6    | Out of credits at provider                                  |
| 7    | Transient / retryable exhausted                             |
| 8    | Provider error                                              |
| 9    | Not found                                                   |

## Discovery

```bash
elv capabilities
elv ops get compose_detailed_stream
elv ops search "text to speech"
elv ops get text_to_speech_full
elv ops schema text_to_speech_full --example   # runnable skeleton
elv spec status
```

The pinned September 6, 2026 spec contains 388 documented operations (source URL, retrieval date, and SHA-256 in `spec/openapi.snapshot.meta.json`); 387 are callable and one deprecated signed-URL route is skipped. Use `elv call <operation_id> --json …` for that compiled REST surface. Use aliases (`tts`, `stt`, `music`, `sfx`, `voice-isolate`, `dubbing-project`, `voices`, `models`, `agents`, `workspace`, …) for common workflows. `elv http` is the forward-compatible REST escape hatch.

`elv models list` reports account-visible `/v1/models` results, not every model across every product. Current examples should prefer `scribe_v2` over deprecated `scribe_v1`, Flash over deprecated Turbo, and `agents tests create` plus `agents tests run` over deprecated `agents simulate`.

## Safety: `--yes`

No interactive prompts. Destructive ops (DELETE), outbound calls/messages, cross-residency voice replication, API-key mutation, and member changes require `--yes`. GET reads are never gated.

```bash
elv call delete_voice --path voice_id=VOICE_ID --yes
```

## Budget: `--max-credits` / `ELV_MAX_CREDITS`

Credit-consuming ops are blocked **pre-flight** when the estimated cost exceeds your ceiling (exit 5, no network). Set per command or via env/config profile.

```bash
elv tts --voice-id VOICE --text "Hello" --max-credits 500
export ELV_MAX_CREDITS=1000
elv usage   # check balance / usage stats
```

When a configured ceiling cannot bound a generation or STT/agent WebSocket session, the CLI fails closed. Raw or non-generation operations with unknown cost report `unknown_unbounded`; do not treat that ceiling as a guarantee.

## Dry-run

`--dry-run` validates and returns a redacted request preview **without** calling the network. It runs **before** `--yes` and budget gates; the envelope includes `would_require_yes` and `would_exceed_budget` when applicable.

**Do not** `--dry-run` secret-create ops with real secret values. Redaction is key-name based and may echo secret body values.

Provider responses containing tokens, signed URLs, API keys, or similar credentials are never returned inline. They are written to a mode `0600` file marked `sensitive: true`; `elv view` refuses to render it.

## Escape hatches

When the registry is not enough:

- `elv http <method> <path>`: arbitrary REST; known paths inherit registry safety/cost metadata
- `elv ws <catalog-name|url>`: protocol-aware scripted WebSocket sessions
- `elv wait`: poll an operation until a JSONPath status resolves

The WebSocket catalog includes `tts-realtime`, `tts-multi`, `ttd-realtime`, `ttd-multi`, `stt-realtime`, `convai`, and `convai-monitor`. Realtime STT uses `send_audio_file` actions with `path`, `sample_rate`, and `commit`; raw binary frames are not the STT protocol. Published query fields such as `--query entity_detection=true` pass through. Use `--token-env NAME` or `--url-env NAME` to keep single-use tokens and signed URLs out of argv. Monitoring is receive-only without `--send`; outbound agent or monitor actions require `--yes`. Use `--dry-run` before a session. Multi-context audio is separated by context rather than concatenated.

`elv music detailed-stream` parses the Music SSE response into audio plus metadata NDJSON files. `music finetunes` manages Finetune training and metadata; generation accepts `--finetune-id`. STT webhook delivery uses bare `--webhook` with an optional configured `--webhook-id`; single-use tokens use `--token-env ENV_NAME` so the token value never appears in argv. `dubbing-project` covers Dubbing v2 source/target transcript editing, `agents procedures` covers the branch-scoped Procedure lifecycle, and `voices accents|replicate` covers the new voice surfaces. `workspace` lists members and manages service accounts.

The public contract now includes Flows image/video/speech generation and Assets. Use `flows image|video|speech create|list|get` (`create --wait` polls to completion), `assets upload|list|get|delete`, and `agents tickets` for triage. Model-specific bodies pass through `--json` or `--json-file`. Flows generation fails closed under a configured credit ceiling because its cost cannot be bounded. Signed `content_url` values stay in private response files; redacted IDs, status, and cursors remain inline. Private editor endpoints are not reverse-engineered.

## Auth and config

Set `ELEVENLABS_API_KEY` (sent as `xi-api-key`; never pass keys as CLI args). Optional `ELV_CACHE_DIR`, `--base-url`, and named **profiles** in config for base URL, output dir, and default `max_credits`.

```bash
elv config get      # -> cacheDir, outputDir, baseUrl, profile, apiKeyPresent
elv config doctor
elv spec status     # -> cache_path: the exact compiled-registry file
```

`config doctor` is offline by default; `--online` explicitly probes connectivity and account credits. Inspect the individual checks: credential presence and successful provider authentication are separate facts.

`speech-engine serve --handler-json '["node","handler.mjs"]' --yes` hosts the inverted Speech Engine protocol on loopback. It verifies incoming signed requests before invoking a handler. Each handler receives one transcript JSON object and emits NDJSON `{text:string}` chunks; exit 0 finalizes the response. Use `--ready-file` for private readiness metadata and `--timeout-ms` for server lifetime. Hosting refuses configured credit ceilings and never deploys or opens a public tunnel automatically.

Do not guess where the compiled registry lives. `elv spec status` prints the resolved `cache_path` (`$ELV_CACHE_DIR`, else `~/.cache/elv`, then the package version, then `openapi.compact.json`) and whether an active registry is present. A repo-local `.elv/` directory is **not** a registry cache: it holds an optional `config.json` for profiles and, if you point `output_dir` there, response artifacts. When no active registry is compiled, commands fall back to the vendored `spec/openapi.snapshot.json`.

## Issue tracking — beads (house rules)

This project uses **bd (beads)** as the work ledger. `bd prime` for commands; `bd ready` on arrival.

- **Beads is the work graph only** — tasks, bugs, dependencies, close-reasons. **`model-performance-journal.md` (delegated-model invocation history) and `CHANGELOG.md` are the narrative and continuity layer and we use them heavily.** Beads never replaces them; a close-reason should point at the journal entry or commit that holds the story.
- Model decisions-needed-from-Trey as blocker beads (human-checkpoint-as-blocker-edge), so dependent work can't be picked up by mistake.
- Create the bead before starting substantial work; close with `--reason`.
- `bd remember` is welcome *alongside* memory files, not instead of them.
- Git behavior comes from this room's own rules (commits ungated, pushes gated — global CLAUDE.md), never from beads tooling.

Do not let `bd` tooling re-inject its managed CLAUDE.md/AGENTS.md block; this section replaces it deliberately.
