# elv agent usage

Agent-first ElevenLabs CLI. Every command is non-interactive and prints **exactly one JSON object** to stdout: success or error. Branch on exit code first; parse the envelope when you need details.

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

The pinned July 23, 2026 spec contains 349 documented operations at SHA-256 `d79f40a567cadc1e9c6933dca59cc8c80e2655490008c43758ad1c6fe0290e4f`; 348 are callable and one deprecated signed-URL route is skipped. Use `elv call <operation_id> --json …` for that compiled REST surface. Use aliases (`tts`, `stt`, `music`, `sfx`, `voice-isolate`, `dubbing-project`, `voices`, `models`, `agents`, `workspace`, …) for common workflows. `elv http` is the forward-compatible REST escape hatch.

`elv models list` reports account-visible `/v1/models` results, not every model across every product. Current examples should prefer `scribe_v2` over deprecated `scribe_v1`, Flash over deprecated Turbo, and `agents tests create` plus `agents tests run` over deprecated `agents simulate`.

## Safety: `--yes`

No interactive prompts. Destructive ops (DELETE), outbound calls/messages, API-key mutation, and member changes require `--yes`. GET reads are never gated.

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

The WebSocket catalog includes `tts-realtime`, `tts-multi`, `stt-realtime`, `convai`, and `convai-monitor`. Realtime STT scripts may use binary file actions. Monitoring is receive-only without `--send`; outbound agent or monitor actions require `--yes`. Use `--dry-run` before a session. Speech Engine upstream is excluded because ElevenLabs connects to a server you host rather than accepting an outbound client connection.

`elv music detailed-stream` parses the Music SSE response into audio plus metadata NDJSON files. `music finetunes` manages Finetune training and metadata; generation accepts `--finetune-id`. STT webhook delivery uses bare `--webhook` with an optional configured `--webhook-id`; single-use tokens use `--token-env ENV_NAME` so the token value never appears in argv. `dubbing-project` edits source and target transcripts; `workspace` lists members and manages service accounts.

The public API contract does not include ElevenCreative's UI-only Image & Video, Avatars, Ads, Flows, or editor workflows. `elv` does not reverse-engineer private endpoints.

## Auth and config

Set `ELEVENLABS_API_KEY` (sent as `xi-api-key`; never pass keys as CLI args). Optional `ELV_CACHE_DIR`, `--base-url`, and named **profiles** in config for base URL, output dir, and default `max_credits`.

```bash
elv config get
elv config doctor
```
