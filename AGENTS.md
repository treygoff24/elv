# elv agent usage

Agent-first ElevenLabs CLI. Every command is non-interactive and prints **exactly one JSON object** to stdout — success or error. Branch on exit code first; parse the envelope when you need details.

## One envelope per command

Stdout is always a single `SuccessEnvelope` or `ErrorEnvelope` (`v: 1`, `ok: true|false`). Binary and large payloads go to disk; paths appear in `files[]`. Never expect human prose, spinners, or multiple JSON lines.

## Exit codes

| Code | Meaning                                                     |
| ---- | ----------------------------------------------------------- |
| 0    | Success                                                     |
| 2    | Input / validation                                          |
| 3    | Auth / permission                                           |
| 4    | Confirmation required — add `--yes`                         |
| 5    | Budget ceiling — raise `--max-credits` or lower the op cost |
| 6    | Out of credits at provider                                  |
| 7    | Transient / retryable exhausted                             |
| 8    | Provider error                                              |
| 9    | Not found                                                   |

## Discovery

```bash
elv ops search "text to speech"
elv ops get text_to_speech_full
elv ops schema text_to_speech_full --example   # runnable skeleton
```

Use `elv call <operation_id> --json …` for full OpenAPI coverage. Use aliases (`tts`, `stt`, `music`, `sfx`, `voice-isolate`, `voices`, `models`, `agents`, `history`, `usage`, …) for common workflows — they call the same runner as `call`.

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

## Dry-run

`--dry-run` validates and returns a redacted request preview **without** calling the network. It runs **before** `--yes` and budget gates; the envelope includes `would_require_yes` and `would_exceed_budget` when applicable.

**Do not** `--dry-run` secret-create ops with real secret values — redaction is key-name based and may echo secret body values.

## Escape hatches

When the registry is not enough:

- `elv http <method> <path>` — arbitrary REST
- `elv ws <catalog-name|url>` — scripted WebSocket sessions
- `elv wait` — poll an operation until a JSONPath status resolves

Same auth, envelope, retries, redaction, and `--yes`/`--max-credits` gating as `call`.

## Auth and config

Set `ELEVENLABS_API_KEY` (sent as `xi-api-key`; never pass keys as CLI args). Optional `ELV_CACHE_DIR`, `--base-url`, and named **profiles** in config for base URL, output dir, and default `max_credits`.

```bash
elv config get
elv config doctor
```
