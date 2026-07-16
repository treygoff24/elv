---
name: elv
description: >-
  Use the elv CLI for ElevenLabs audio and voice work from the command line:
  generate speech (TTS), transcribe audio (STT), create sound effects or music,
  clone, convert, or isolate voices, dub video/audio, edit Dubbing Project
  transcripts, and manage ElevenLabs voices, account-visible models,
  conversational agents, workspaces, history, and usage. elv invokes all 338
  operations compiled from its pinned ElevenLabs OpenAPI document, plus raw REST
  and protocol-aware WebSocket calls.
  It is agent-first: every command is non-interactive and prints exactly one JSON
  envelope to stdout, with binary and large output written to disk. Reach for elv
  whenever the user wants ElevenLabs text-to-speech, speech-to-text, voice
  cloning, sound effects, music, dubbing, or any ElevenLabs REST/WebSocket call.
---

# elv

`elv` is an agent-first CLI over the ElevenLabs OpenAPI spec. Binary is `elv`
(or `node dist/cli.js`). Requires Node >= 22.

## The contract

Every command writes exactly one JSON object to stdout: a success envelope
(`{"v":1,"ok":true,...}`) or an error envelope (`{"v":1,"ok":false,...}`). No
prose, no spinners, no multiple JSON lines, no interactive prompts. Binary
results and large JSON go to disk; their paths appear in `files[]`.

Branch on the exit code first. Parse the envelope only when you need detail.

| Code | Meaning |
| ---- | ------- |
| 0 | Success |
| 2 | Input / validation (bad params, local pre-flight) |
| 3 | Auth / permission |
| 4 | Confirmation required: add `--yes` |
| 5 | Budget ceiling: raise `--max-credits` or lower the op cost |
| 6 | Out of credits at provider |
| 7 | Transient / retryable, retries exhausted |
| 8 | Provider error (other 4xx/5xx) |
| 9 | Not found (404, unknown operation_id) |

A success envelope carries `operation_id`, `http`, `cost`, and either `data`
inline or `files[]` plus a `data_summary`. An error envelope carries
`error.type`, `error.code`, `error.message`, `retry`, and often a `hints[]`
entry with a suggested next command (e.g. `elv config doctor` on an auth failure,
`elv voices list` when a voice id is not found).

## Three ways to act

1. Aliases for the common workflows. Fourteen thin commands that build the request
   and call the same core runner as `call`: `tts`, `stt`, `music`, `sfx`,
   `voice-change`, `voice-isolate`, `dubbing`, `dubbing-project`, `voices`,
   `models`, `agents`, `history`, `usage`, `workspace`. Use these first when one
   fits.
2. `elv call <operation_id> --json '{...}'` for all 338 callable operations in
   the pinned spec. Use this when no alias fits.
3. Escape hatches when the registry is not enough: `elv http <METHOD> <path>`
   for forward-compatible REST, `elv ws <catalog|url>` for protocol-aware
   WebSocket sessions (run `elv ws --list` for the catalog), and `elv wait` to
   poll an operation until a status field resolves.

They share the envelope and configuration contract. Known raw REST paths inherit
registry safety and cost metadata. WebSocket safety and cost behavior is based
on the selected protocol; an unknown raw target cannot inherit metadata that the
CLI does not have.

Parent alias commands need a subcommand. `elv voices` alone exits 2 and lists
the valid subcommands; run `elv voices list`. (`elv ops`, `elv config`, and
`elv spec` print their subcommands and exit 0.)

## Discovery

When you do not know the operation id or its shape:

```bash
elv capabilities                           # bounded machine contract + service map
elv ops list --risk generate --limit 20    # filter the operation inventory
elv ops search "text to speech"          # find operation ids by keyword
elv ops get text_to_speech_full          # method, path, params, risk
elv ops schema text_to_speech_full --example   # runnable elv call skeleton
elv spec status                           # active spec provenance
```

`--example` prints a ready-to-run `call` with the input buckets filled in. Add
`--raw` to `ops schema` for the raw JSON Schema. `elv <command> --help` prints
that command's own flags and arguments. The pinned July 16, 2026 document has
339 published operations at SHA-256
`de0476611805f3ee4e6a6c76dcdd6cc9686b8daee5757e6465d2974094c844ce`;
338 are callable and one deprecated signed-URL route is skipped. Use `spec diff`
to inspect current drift and `spec update` to refresh the validated cache.

## Safety gates

No interactive prompts ever. Destructive operations (DELETE), outbound
calls/messages, API-key mutation, and member changes require `--yes`. GET reads
are never gated.

### Confirmation failure

```bash
elv call delete_voice --path voice_id=VOICE_ID
# exit 4, {"ok":false,"error":{"type":"confirmation_required","code":"confirmation",...}}
```

Add `--yes` only after confirming the deletion is intended.

`--max-credits N` (or `ELV_MAX_CREDITS`) blocks a credit-consuming op pre-flight,
before any network call, when the estimate exceeds the ceiling:

```bash
elv tts --voice-id VOICE --text "Long script..." --max-credits 5
# exit 5, {"ok":false,"error":{"type":"budget_exceeded","code":"budget",...}}
```

Estimates are calibrated: TTS Flash/Turbo about 0.5 credits/char, standard TTS
about 1.0/char, STT about 27 credits/min. A configured ceiling fails closed for
generation and STT/agent WebSocket sessions whose cost cannot be estimated. Raw
or non-generation operations with unknown cost report `unknown_unbounded`; the
ceiling is not a guarantee there.

`--dry-run` validates and returns a redacted request preview without touching the
network. It runs before the `--yes` and budget gates, so the preview tells you
in advance what would happen:

```bash
elv tts --voice-id VOICE --text "Hello" --dry-run
# ok:true, data:{ dry_run:true, request:{...redacted...},
#   credits_estimated, would_require_yes, would_exceed_budget }
```

Do not `--dry-run` secret-create ops with real secret values; redaction keys on
field names and may echo a secret passed as a plain value.

Provider responses containing tokens, signed URLs, API keys, or similar
credentials are file-only: the file mode is `0600`, the envelope marks it
`sensitive: true`, and `elv view` refuses to display it.

## Output handling

Binary output goes to a file. Pass `--out <file-or-dir>`; otherwise it lands in
the output directory (default `~/.cache/elv/out`, override with `ELV_OUTPUT_DIR`
or a profile `output_dir`). An extensionless `--out` is treated as a directory.
The envelope's `files[]` gives each path, mime, byte size, and sha256.

Large JSON (long lists, big responses) also spills to disk: the envelope returns
`files[]` plus a `data_summary` (type, count, a short preview) and a `hints[]`
entry instead of flooding stdout. Inspect a spilled file WITHOUT loading it into
context with `elv view`:

```bash
elv view <path>                              # full content if small, else a summary
elv view <path> --path data.voices.0.name    # drill into a dotted JSON path
elv view <path> --path voices --limit 5       # first N items of an array
elv view <path> --path 'voices[].name'        # project one field across every item
```

`elv view` reads the spilled JSON (or NDJSON), applies an optional `--path`
(dotted, with numeric array indices and a `[]` array wildcard) and `--limit`, and
returns the slice inline when small or a `data_summary` plus a narrow-further hint
when still large. `voices[].name` flattens to `["Bella ...", "Bill ...", ...]`;
`voices[]` returns the array itself.

Pagination works on the list aliases (`voices list`, `history list`,
`agents list`, `dubbing list`) and on `call`/`http`: `--limit N` sets the page
size and caps inlined items, `--all` walks every page and writes the full set to
the `--save-json`/`--out` target (one of which is required with `--all`),
`--save-json <path>` chooses the output path. A large single page spills to disk
but still returns the `next` page command inline so you can keep paging.

When you only need a couple of fields per row, skip the spill: the list aliases
take `--fields <csv>` and return the whole list projected and inline.
`elv voices list --fields voice_id,name` is a sub-KB envelope instead of a ~100 KB
spill, which is the fastest way to get an id/name table to pick from.

## Auth

Set `ELEVENLABS_API_KEY` in the environment; elv sends it as the `xi-api-key`
header. Never pass the key as a CLI argument. Request credentials are redacted
from envelopes and logs. Credential-producing provider responses follow the
restrictive file-only contract above. Check setup with `elv config get` and
`elv config doctor`.

## Models

`elv models list` returns the account-visible `/v1/models` response. It is not
an exhaustive catalog of STT, realtime STT, Sound Effects, Text to Voice, Music,
or other product model IDs. Alias model values pass through as strings. A
profile's `default_model_id` applies to TTS REST and named TTS WebSocket calls
when no model is supplied.

Current documented families are:

- TTS: `eleven_v3`, `eleven_multilingual_v2`, `eleven_flash_v2_5`, `eleven_flash_v2`
- Text to Voice: `eleven_ttv_v3`, `eleven_multilingual_ttv_v2`
- Speech to Speech: `eleven_multilingual_sts_v2`, `eleven_english_sts_v2`
- STT: `scribe_v2`, `scribe_v2_realtime`
- Sound Effects: `eleven_text_to_sound_v2`
- Music: `music_v2`, `music_v1`

Deprecated: replace `eleven_turbo_v2_5` with `eleven_flash_v2_5`,
`eleven_turbo_v2` with `eleven_flash_v2`, and `scribe_v1` with `scribe_v2`.
Actual availability depends on the account and rollout.

## Recipes

| Task | Command |
| ---- | ------- |
| Check balance / tier / usage | `elv usage` |
| Character usage over a range | `elv usage --from 2026-06-01 --to 2026-06-25` |
| List models | `elv models list` |
| List voices | `elv voices list` |
| List voices (compact id/name) | `elv voices list --fields voice_id,name` |
| Search voices (name / labels) | `elv voices list --search "narration"` |
| Find a voice by name | `elv voices find "Rachel"` (matches exact name, else unique substring) |
| Get one voice | `elv voices get VOICE_ID` (or `--voice-id VOICE_ID`) |
| Text to speech | `elv tts --voice-id VOICE_ID --text "Hello" --model eleven_flash_v2_5 --out out.mp3` |
| TTS by voice name | `elv tts --voice "Rachel" --text "Hello" --out out.mp3` |
| TTS with timestamps | `elv tts --voice-id VOICE_ID --text "Hello" --timestamps --out out.mp3` (writes `out.mp3` plus a sidecar `out.timestamps.json` with the alignment data) |
| Speech to text | `elv stt --file note.m4a --model scribe_v2` |
| Sound effect | `elv sfx --prompt "thunderclap" --duration 5 --out sfx.mp3` |
| Music | `elv music --prompt "lofi beat" --model music_v2 --length-ms 30000 --out track.mp3` |
| Music detailed SSE | `elv music detailed-stream --prompt "lofi beat" --model music_v2 --out ./music-session` (audio + metadata NDJSON in `files[]`) |
| Convert voice (speech to speech) | `elv voice-change --voice-id VOICE_ID --file in.mp3 --out out.mp3` |
| Isolate voice from noise | `elv voice-isolate --file in.mp3 --out clean.mp3` |
| Clone a voice (instant) | `elv voices clone-instant --name "My Voice" --file sample.mp3` |
| Create a dub, wait for it | `elv dubbing create --file in.mp4 --source en --target es --wait` |
| Get dubbed audio | `elv dubbing audio --id DUB_ID --language es --out dubbed.mp3` |
| List agents | `elv agents list` |
| Create agent test | `elv agents tests create --json-file test.json` |
| Run agent tests | `elv agents tests run --agent-id AGENT_ID --json-file run.json` |
| Agent RAG diagnostic | `elv agents rag-query --agent-id AGENT_ID --query "refund policy"` |
| List workspace members | `elv workspace members list` |
| Create service account | `elv workspace service-accounts create --name deployer --yes` (credential response is file-only) |
| Get Dubbing Project transcript | `elv dubbing-project transcript get --project-id PROJECT_ID` |
| Speech history | `elv history list --limit 20` |
| Any operation by id | `elv call <operation_id> --json '{"path":{...},"query":{...},"body":{...}}'` |
| Inspect a spilled JSON result | `elv view <path> --path data.voices.0` |
| Raw REST call | `elv http GET /v1/user` |
| Scripted WebSocket session | `elv ws tts-realtime --query voice_id=VOICE --send script.ndjson --out ./session` |
| Realtime STT WebSocket | `elv ws stt-realtime --send transcribe.ndjson --out ./session` (supports `send_binary_file`) |
| Receive conversation monitor | `elv ws convai-monitor --query conversation_id=ID --out ./monitor` |
| Poll a long job | `elv wait --operation get_dubbed_metadata --json '{"path":{"dubbing_id":"abc"}}' --status-path '$.data.status' --success 'dubbed' --failure 'failed' --interval-ms 2000 --timeout-ms 600000` (`--failure` is optional; success-only polling works) |

`agents simulate` remains for compatibility but invokes an operation ElevenLabs
marks deprecated. Prefer `agents tests create` followed by `agents tests run`.

The WebSocket catalog is `tts-realtime`, `tts-multi`, `stt-realtime`, `convai`,
and `convai-monitor`. TTS, STT, agent, and monitor scripts have protocol-specific
validation. Outbound agent or monitor actions require `--yes`; receive-only
monitoring does not. Use `--dry-run` before connecting. Speech Engine upstream
is not a client target because ElevenLabs connects to a server you host.

The public API does not expose ElevenCreative's UI-only Image & Video, Avatars,
Ads, Flows, or editor workflows. Do not reverse-engineer private endpoints.

### call input shape

`call` takes one `--json` object with `path`, `query`, `body`, and `files`
buckets. You can also build it from flags: `--path key=value`, `--query key=value`,
`--file field=path`, repeated as needed. `--json-file <path>` and `--stdin-json`
read the JSON from a file or stdin. `--allow-unknown` routes flat top-level keys
into the body.

```bash
elv call text_to_speech_full \
  --json '{"path":{"voice_id":"21m00Tcm4TlvDq8ikWAM"},"body":{"text":"Hello","model_id":"eleven_v3"}}' \
  --out ./out
```

### Common flags

Every command accepts `--dry-run`, `--yes`, `--max-credits <n>`, `--out <path>`,
`--base-url <url>`, `--profile <name>`, `--debug`, and `--retry-post`. The list
aliases (`voices list`, `history list`, `agents list`, `dubbing list`) and
`call`/`http` take `--limit <n>` (page size + inline cap), `--all` (walk every
page to a file; requires `--save-json`/`--out`), and `--save-json <path>`; the
list aliases also take `--fields <csv>` to project rows to a chosen set of fields
inline. Every command's own flags are documented in `elv <command> --help`.
