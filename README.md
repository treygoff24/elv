# elv

An agent-first ElevenLabs CLI. One JSON envelope per command, with the published REST API behind it.

Independent project; not affiliated with or endorsed by ElevenLabs.

## Why this exists

The ElevenLabs MCP server sucks, and the official skills basically expect your agent to hand-roll raw API calls through brittle wrappers. Worse, the MCP exposes a thin slice of what ElevenLabs can actually do. The API has more than three hundred operations; the MCP surfaces a fraction of them.

So we built `elv`: a simple, token-efficient, agent-first CLI over ElevenLabs' published API. The vendored July 23, 2026 OpenAPI document contains 349 operations; `elv` compiles 348 of them and deliberately skips one deprecated signed-URL route whose replacement is available. Each command returns one JSON envelope and an exit code an agent can branch on before parsing the result.

## What is this?

`elv` is a command-line tool that compiles the ElevenLabs OpenAPI spec for AI coding agents to drive. Text-to-speech, speech-to-text, music, sound effects, dubbing, voice cloning, conversational agents, usage, and history are all available through the generic runner. Named WebSocket clients cover the public client-side realtime protocols. [API coverage and its boundaries are documented explicitly](./docs/api-coverage.md).

Every command is non-interactive and prints exactly one line of JSON to stdout, either a success envelope or an error envelope. Anything that isn't JSON (audio, transcripts, large payloads) is written to disk, and the file paths come back inside the envelope. No spinners, no prose, no second line. An agent branches on the exit code first and parses the envelope only when it needs the detail.

Humans can use it too, and it reads fine at a terminal. But the design target is an agent that needs to get a job done and move on without burning tokens on screen-scraping.

## If you're an agent reading this

Route yourself by what your human actually asked for.

| Your situation | Where to go |
| --- | --- |
| They sent you to figure out what this is | The [What is this?](#what-is-this) section above, then [AGENTS.md](./AGENTS.md) for the contract |
| They want you to install and set this up on this machine | [docs/agent-setup.md](./docs/agent-setup.md), start to finish |
| They want you to actually use it | [AGENTS.md](./AGENTS.md) for the protocol, and the shipped skill at [skills/elv/SKILL.md](./skills/elv/SKILL.md) |

The short version of the contract: run a command, check the exit code, and read `files[]` in the envelope to find any output.

## Features

Three layers sit over the ElevenLabs OpenAPI spec, from most general to most convenient.

The generic runner, `elv call <operation_id> --json '{...}'`, can invoke all 348 operations compiled from the pinned OpenAPI document. Nothing is hidden behind a hand-written subset. Escape hatches cover published endpoints that have not reached the pinned registry yet: `elv http <METHOD> <path>` makes an arbitrary REST call against the configured base URL, `elv ws <catalog|url>` runs a scripted WebSocket session, and `elv wait` polls an operation until a status field resolves. Known raw REST requests inherit registry metadata. Otherwise, safety and budget behavior depends on what protocol information is available.

Fourteen thin aliases wrap common workflows: `tts`, `stt`, `music`, `sfx`, `voice-change`, `voice-isolate`, `dubbing`, `dubbing-project`, `voices`, `agents`, `models`, `history`, `usage`, and `workspace`. Each one builds an input and calls the same runner as `call`. Discovery is built in too: `elv capabilities` reports the machine contract and service map; `elv ops list`, `ops search`, `ops get`, and `ops schema` inspect the registry; and `elv spec status`, `spec diff`, and `spec update` expose and refresh the active spec provenance.

Safety is on by default. Destructive operations, outbound calls and messages, API-key mutation, and member changes refuse to run without `--yes`. Plain GET reads are never gated. A budget guard blocks credit-consuming calls before any network request when the cost can be bounded. A configured ceiling fails closed for generation operations and STT or agent WebSocket sessions whose cost cannot be estimated. `--dry-run` validates a request and returns a redacted preview without spending anything.

## Install

Requires Node 22 or newer.

```bash
npm install -g eleven-agent-cli
elv config doctor
```

That installs the `elv` command globally. If you'd rather build from source (or want to contribute), clone and build instead:

```bash
git clone https://github.com/treygoff24/elv.git
cd elv
npm ci
npm run build
npm link            # gives you a global `elv`
elv config doctor
```

Or skip the link and invoke the built file directly:

```bash
node dist/cli.js config doctor
```

If you're an agent setting this up on a fresh machine, follow [docs/agent-setup.md](./docs/agent-setup.md) instead; it covers verification and troubleshooting step by step.

## Quickstart

```bash
# 1. Point elv at your account (sent as the xi-api-key header; never as a CLI arg).
export ELEVENLABS_API_KEY=your_key_here

# 2. Confirm the environment is healthy.
elv config doctor

# 3. Find an operation.
elv ops search "text to speech"

# 4. Preview a call without spending credits.
elv tts --voice-id JBFqnCBsd6RMkjVDRZzb --text "Hello from elv." \
  --model eleven_flash_v2_5 --dry-run

# 5. Run it for real.
elv tts --voice-id JBFqnCBsd6RMkjVDRZzb --text "Hello from elv." \
  --model eleven_flash_v2_5 --out out.mp3
```

## Usage

### Discovery

Start with the bounded machine-readable service map, then search the vendored OpenAPI registry and copy a runnable example:

```bash
elv capabilities
elv ops get compose_detailed_stream
elv ops search "text to speech"
elv ops get text_to_speech_full
elv ops schema text_to_speech_full --example
elv spec status
```

The `--example` flag prints an `elv call` skeleton with the parameter shape filled in. Edit and run it. `elv spec diff` compiles the current provider document and reports drift without writing the cache; `elv spec update` installs the validated registry transactionally. `elv <command> --help` lists that command's own flags.

### Aliases

The fourteen aliases are sugar over the same runner as `call`.

| Alias | Purpose |
| --- | --- |
| `tts` | Text-to-speech (voice id or name, text or file, optional stream and timestamps) |
| `stt` | Speech-to-text transcription, configured-webhook delivery, and env-sourced single-use tokens |
| `music` | Music generation, detailed SSE audio and metadata, and Music Finetunes |
| `sfx` | Text-to-sound-effects generation |
| `voice-change` | Speech-to-speech voice conversion |
| `voice-isolate` | Background-noise removal |
| `dubbing` | Dubbing create, get, and audio workflows |
| `dubbing-project` | Dubbing Project source and target transcript editing |
| `voices` | Voice list, search, get, clone |
| `agents` | ElevenAgents lifecycle, tests, test runs, and RAG diagnostics |
| `models` | List the models visible to the authenticated account from `/v1/models` |
| `history` | Generated-audio history list, audio, delete |
| `usage` | Subscription balance or date-range character stats |
| `workspace` | List members and create or list service accounts |

```bash
elv tts --voice-id JBFqnCBsd6RMkjVDRZzb --text "Hello from elv." --out ./out
elv voices list
elv usage --from 2026-06-01 --to 2026-06-25
elv dubbing get --id abc123
elv agents tests create --json-file test.json
elv workspace members list
elv music finetunes list --limit 10
```

`agents simulate` remains as a compatibility alias but calls an operation ElevenLabs marks deprecated. New automation should use `agents tests create` followed by `agents tests run`.

Music Finetunes are managed under `music finetunes`. Training uses repeatable `--file` inputs and is subject to ElevenLabs account entitlement, charges, and ownership/copyright rules:

```bash
elv music finetunes create --name "Live Jazz" --primary-genre jazz \
  --file take-1.wav --file take-2.wav --model music_v2 --dry-run
elv music --prompt "A warm jazz trio" --finetune-id FINETUNE_ID --out track.mp3
elv music finetunes update --finetune-id FINETUNE_ID --json '{"visibility":"workspace"}'
elv music finetunes delete --finetune-id FINETUNE_ID --yes
```

For asynchronous STT, configure a workspace webhook first, then pass boolean `--webhook` and optionally `--webhook-id`. A single-use Scribe token is read from an environment variable so its value never enters argv:

```bash
elv stt --file note.m4a --model scribe_v2 --webhook --webhook-id WEBHOOK_ID
elv stt --file note.m4a --model scribe_v2 --token-env SCRIBE_TOKEN
```

### The generic runner

For anything outside the alias surface, call any operation by id. The `--json` body uses the bucketed shape (`path`, `query`, `body`), and `--path key=value` is a shorthand for single path parameters.

```bash
elv call text_to_speech_full \
  --json '{"path":{"voice_id":"JBFqnCBsd6RMkjVDRZzb"},"body":{"text":"Hello.","model_id":"eleven_v3"}}' \
  --out ./out

elv call delete_voice --path voice_id=VOICE_ID --yes
```

Large or paginated results never flood stdout. The list aliases (`voices list`, `history list`, `agents list`, `dubbing list`, `music finetunes list`) and `call`/`http` take `--limit <n>` (sets the page size and caps what gets inlined), `--all` to fetch every page to disk (requires `--save-json`/`--out`), and `--save-json <path>` to write the full result somewhere you choose. A large single page spills to disk but still returns the `next` page command inline so you can keep paging. Inspect any spilled file without loading it into context with `elv view <path> [--path <dotted>] [--limit <n>]`.

To skip the spill entirely when you only need a couple of fields per row, the list aliases take `--fields <csv>`: `elv voices list --fields voice_id,name` projects each voice down to those keys and returns the whole list inline (sub-KB instead of ~100 KB). For arbitrary spilled files, `elv view <path> --path 'voices[].name'` does the same projection with a `[]` array wildcard.

### Escape hatches

When an endpoint is missing from the registry, still in beta, or needs a raw path, drop down to the primitives.

```bash
# Arbitrary REST against the configured base URL.
elv http GET /v1/user
elv http POST /v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb \
  --body-json '{"text":"Hi","model_id":"eleven_v3"}' --out ./out

# Scripted WebSocket session (catalog name, configured-host path, or raw wss:// URL).
elv ws --list
elv ws tts-realtime --query voice_id=VOICE --query model_id=eleven_flash_v2_5 \
  --send script.ndjson --out ./session

# Realtime STT accepts send_binary_file actions in the NDJSON script.
elv ws stt-realtime --send transcribe.ndjson --out ./session --dry-run

# Conversation monitoring is receive-only without --send; outbound controls require --yes.
elv ws convai-monitor --query conversation_id=CONVERSATION_ID --out ./monitor

# Poll an operation until a status field resolves.
elv wait --operation get_dubbed_metadata \
  --json '{"path":{"dubbing_id":"abc"}}' \
  --status-path '$.data.status' \
  --success 'dubbed' --failure 'failed' \
  --interval-ms 2000 --timeout-ms 600000
```

The named WebSocket catalog contains `tts-realtime`, `tts-multi`, `stt-realtime`, `convai`, and `convai-monitor`. Script validation is protocol-specific: the TTS keep-alive is required only for TTS, binary file actions are accepted only for STT and raw sessions, and `eleven_v3` is rejected for WebSocket TTS. `--dry-run`, `--yes`, and `--max-credits` apply to catalog sessions, but a ceiling rejects STT and agent sessions whose cost cannot be bounded before connection.

Speech Engine upstream is not a WebSocket target. It is an inverted protocol in which ElevenLabs connects to a server you host, so `elv ws` intentionally does not pretend to implement it.

### Music detailed streaming

The detailed Music endpoint returns Server-Sent Events rather than a normal audio body. `elv music detailed-stream` parses the event framing, decodes audio chunks to an audio file, and writes the remaining event metadata as NDJSON. Both paths are returned in `files[]`.

```bash
elv music detailed-stream --prompt "A tense string quartet" --model music_v2 \
  --timestamps --out ./music-session
```

If a paid stream becomes malformed after valid data, the error envelope keeps any completed audio and events as `partial: true` files rather than discarding them.

## Configuration and auth

Set `ELEVENLABS_API_KEY` and `elv` sends it as the `xi-api-key` header. Never pass the key as a CLI argument. STT single-use tokens likewise use `--token-env ENV_NAME`, never the token value. Request credentials are redacted from envelopes and logs. Provider responses that create a token, signed URL, API key, or similar credential are deliberately written to a mode `0600` file instead of returned inline; the envelope marks that file `sensitive: true`.

```bash
export ELEVENLABS_API_KEY=your_key_here
elv config get
elv config doctor
```

`elv config doctor` checks the things that usually go wrong: API key present, base URL set, the registry cache, output-directory writability, Node version, base-URL reachability, and your credit balance.

Named profiles let you keep more than one setup. A config file at `.elv/config.json` (in the working directory) or `~/.config/elv/config.json` can define profiles with a base URL, an output directory, a default model, a default `max_credits`, and the name of the environment variable that holds the key. The config file stores the variable name, not the secret itself, so nothing sensitive lands on disk. Select a profile with `--profile <name>` or `ELV_PROFILE`.

A few environment variables and flags adjust the rest. `--base-url` or `ELEVENLABS_BASE_URL` overrides the endpoint, `ELEVENLABS_API_RESIDENCY` (`us`, `eu`, `in`, `sg`) picks a residency host, `ELV_OUTPUT_DIR` changes where output spills (default `~/.cache/elv/out`), and `ELV_CACHE_DIR` changes where the compiled spec registry is cached (default `~/.cache/elv`).

## Models

`elv models list` returns the models visible to the authenticated account from `GET /v1/models`. It is not an exhaustive catalog across every ElevenLabs product: STT, realtime STT, Sound Effects, Text to Voice, and Music model IDs are documented on other API surfaces and may not appear in that response. Alias `--model` values pass through as strings so provider-enabled models do not require a CLI release. A profile's `default_model_id` applies to TTS REST and named TTS WebSocket calls when no model is supplied.

The official model reference retrieved on July 16, 2026 lists these current families:

| Area | Model IDs |
| --- | --- |
| Text to Speech | `eleven_v3`, `eleven_multilingual_v2`, `eleven_flash_v2_5`, `eleven_flash_v2` |
| Text to Voice | `eleven_ttv_v3`, `eleven_multilingual_ttv_v2` |
| Speech to Speech | `eleven_multilingual_sts_v2`, `eleven_english_sts_v2` |
| Speech to Text | `scribe_v2`, `scribe_v2_realtime` |
| Sound Effects | `eleven_text_to_sound_v2` |
| Music | `music_v2`, `music_v1` |

ElevenLabs marks `eleven_turbo_v2_5`, `eleven_turbo_v2`, and `scribe_v1` deprecated. Use `eleven_flash_v2_5`, `eleven_flash_v2`, and `scribe_v2` respectively. Model availability still depends on the account, region, plan, and rollout. See [API coverage](./docs/api-coverage.md) for the pinned source and limits.

## Safety and budget

There are no interactive prompts, so anything with a side effect has to be confirmed explicitly. Destructive operations (DELETE), outbound calls and messages, API-key mutation, and member changes all require `--yes`. Reads are never gated.

```bash
elv call delete_voice --path voice_id=VOICE_ID --yes
```

Credit-consuming calls can be capped before they run. With `--max-credits` (or `ELV_MAX_CREDITS`, or a profile default), `elv` estimates supported operations and fails with exit 5 before touching the network when the estimate exceeds the ceiling. It also fails closed for generation operations and STT or agent WebSocket sessions whose cost cannot be bounded. A raw or non-generation operation with unknown cost reports `unknown_unbounded`; its ceiling is not a guarantee.

Current estimates use about 0.5 credits per character for TTS Flash and Turbo, 1.0 for other TTS models, and about 27 credits per minute for speech-to-text. Music uses a conservative five-minute cap when generated length is unknown. Treat every estimate as a pre-flight guard, not an invoice; provider response headers remain the source for charged credits when available.

```bash
elv tts --voice-id VOICE --text "Long script..." --max-credits 500 --out ./out
```

`--dry-run` validates the request and returns a redacted preview without calling the network. It runs before the `--yes` and budget gates, and the envelope reports `would_require_yes`, `would_exceed_budget`, and the budget policy. One caution: do not dry-run a secret-create operation with a real secret value, because input redaction is keyed on field names and may echo a secret passed in an innocuously named body field. The full agent protocol is in [AGENTS.md](./AGENTS.md).

`elv view` refuses to render files marked as sensitive provider responses. Read one directly only when you intend to reveal the credential, then protect or delete it as you would any API key.

## The envelope contract

Stdout is always a single JSON object: a `SuccessEnvelope` or an `ErrorEnvelope`, both carrying `v: 1` and `ok: true` or `ok: false`. A success envelope can include `data`, `data_summary`, `files[]`, `cost`, `http`, `warnings`, and `hints[]`. An error envelope carries a normalized `error` (`type`, `code`, `message`) plus optional `retry` guidance and `hints[]` with a suggested next command. Binary and oversized payloads are written to disk and referenced as `files[]` entries with a path, MIME type, byte count, and sha256. The full type definitions live in `src/core/types.ts`.

### Exit codes

Branch on the exit code before parsing anything.

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 2 | Input or validation (bad parameters, local pre-flight) |
| 3 | Auth or permission |
| 4 | Confirmation required: add `--yes` |
| 5 | Budget ceiling: raise `--max-credits` or lower the op cost |
| 6 | Out of credits at the provider |
| 7 | Transient or retryable error, retries exhausted |
| 8 | Provider error (other 4xx/5xx) |
| 9 | Not found (404, unknown `operation_id`) |

## Examples

These are real runs, lightly trimmed.

Check your balance:

```bash
elv usage
# {"v":1,"ok":true,"data":{"tier":"creator","character_count":...,"character_limit":...}}
```

List voices (the v2 payload is large, so it spills to disk; the `next` page command and an `elv view` hint come back inline):

```bash
elv voices list
# {"v":1,"ok":true,"operation_id":"get_user_voices_v2",
#  "data":{"next":{"cmd":"elv call get_user_voices_v2 --json '{...}'"}},
#  "files":[{"path":"~/.cache/elv/out/get_user_voices_v2-response.json",...}],
#  "data_summary":{...},"hints":[{"cmd":"elv view '<path>' --path 'voices'",...}]}

# Then inspect it without loading the whole file into context:
elv view ~/.cache/elv/out/get_user_voices_v2-response.json --path voices --limit 3

# Or skip the spill: project just the fields you need, inline.
elv voices list --fields voice_id,name
# {"v":1,"ok":true,"data":{"voices":[{"voice_id":"...","name":"Bella ..."}, ...]}}
```

Synthesize speech and get the file back with a real charge from the response header:

```bash
elv tts --voice-id JBFqnCBsd6RMkjVDRZzb --text "Hello" --model eleven_flash_v2_5 --out out.mp3
# {"v":1,"ok":true,"files":[{"path":"out.mp3","mime":"audio/mpeg","bytes":...,"sha256":"..."}],
#  "cost":{"credits_estimated":...,"credits_charged":...,"credits_source":"header"}}
```

Transcribe audio:

```bash
elv stt --file note.m4a --model scribe_v2
# transcript spilled to ~/.cache/elv/out/, cost includes the real credits_charged
```

Hit the budget ceiling (exit 5, no network call):

```bash
elv tts --voice-id VOICE --text "..." --max-credits 5
# exit 5: {"v":1,"ok":false,"error":{"type":"budget_exceeded","code":"budget","message":"Estimated credits N exceed cap 5"}}
```

Forget `--yes` on a destructive op (exit 4):

```bash
elv call delete_voice --path voice_id=X
# exit 4: {"v":1,"ok":false,"error":{"type":"confirmation_required","code":"confirmation",
#          "message":"delete_voice (destructive) requires --yes"}}
```

Preview without spending (exit 0):

```bash
elv tts --voice-id VOICE --text "..." --dry-run
# {"v":1,"ok":true,"data":{"would_require_yes":...,"would_exceed_budget":...,
#   "credits_estimated":...,"request":{...}}}
```

## Development

The gate, in order, is build, typecheck, test, lint:

```bash
npm run build        # tsup
npm run typecheck    # tsc --noEmit
npm test             # vitest run
npm run lint         # oxlint
```

`npm run format` applies the formatter; `npm run format:check` checks without writing.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the workflow and conventions, and [SECURITY.md](./SECURITY.md) for how to report a vulnerability.

## License

MIT. See [LICENSE](./LICENSE).
