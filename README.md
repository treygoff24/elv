# elv

An agent-first ElevenLabs CLI. One JSON envelope per command, the whole API behind it.

## Why this exists

The ElevenLabs MCP server sucks, and the official skills basically expect your agent to hand-roll raw API calls through brittle wrappers. Worse, the MCP exposes a thin slice of what ElevenLabs can actually do. The API has more than three hundred operations; the MCP surfaces a fraction of them.

So we built `elv`: a simple, token-efficient, agent-first CLI that makes full use of the API. This is an ElevenLabs CLI that lets your agents do anything the ElevenLabs API can do, not a limited subset. All 320 operations, one JSON envelope per command, and exit codes an agent can branch on without parsing a thing.

## What is this?

`elv` is a command-line tool that wraps the entire ElevenLabs OpenAPI spec for AI coding agents to drive. Text-to-speech, speech-to-text, music, sound effects, dubbing, voice cloning, conversational agents, usage, history: if the API exposes it, `elv` can call it.

Every command is non-interactive and prints exactly one line of JSON to stdout, either a success envelope or an error envelope. Anything that isn't JSON (audio, transcripts, large payloads) is written to disk, and the file paths come back inside the envelope. No spinners, no prose, no second line. An agent branches on the exit code first and parses the envelope only when it needs the detail.

Humans can use it too, and it reads fine at a terminal. But the design target is an agent that needs to get a job done and move on without burning tokens on screen-scraping.

## If you're an agent reading this

Route yourself by what your human actually asked for.

| Your situation | Where to go |
| --- | --- |
| They sent you to figure out what this is | The [What is this?](#what-is-this) section above, then [AGENTS.md](./AGENTS.md) for the contract |
| They want you to install and set this up on this machine | [docs/agent-setup.md](./docs/agent-setup.md), start to finish |
| They want you to actually use it | [AGENTS.md](./AGENTS.md) for the protocol, and the shipped skill at [skills/elv/SKILL.md](./skills/elv/SKILL.md) |

The short version of the contract: run a command, check the exit code, and read `files[]` in the envelope to find any output. Exit-code meanings are in [the table below](#exit-codes).

## Features

Three layers sit over the ElevenLabs OpenAPI spec, from most general to most convenient.

The generic runner, `elv call <operation_id> --json '{...}'`, can invoke any of the 320 operations in the spec. Nothing is hidden behind a hand-written subset.

Escape hatches cover anything the registry doesn't. `elv http <METHOD> <path>` makes an arbitrary REST call against the configured base URL. `elv ws <catalog|url>` runs a scripted WebSocket session. `elv wait` polls an operation until a status field resolves. All three share the same auth, envelope, retries, and secret redaction as `call`.

Twelve thin aliases wrap the common workflows: `tts`, `stt`, `music`, `sfx`, `voice-change`, `voice-isolate`, `dubbing`, `voices`, `agents`, `models`, `history`, and `usage`. Each one builds an input and calls the same runner as `call`. No alias ships its own HTTP client, so they all inherit the same behavior.

Discovery is built in. `elv ops search "<query>"` finds operations, `elv ops get <id>` shows one, and `elv ops schema <id> --example` prints a ready-to-run skeleton you can fill in and execute.

Safety is on by default. Destructive operations, outbound calls and messages, API-key mutation, and member changes refuse to run without `--yes`. Plain GET reads are never gated. A budget guard blocks credit-consuming calls before any network request when the estimate exceeds your ceiling. And `--dry-run` validates a request and returns a redacted preview without spending anything.

## Install

Not on npm yet. Publishing is planned; for now you clone and build. You need Node 22 or newer and git.

```bash
git clone https://github.com/treygoff24/elv.git
cd elv
npm ci
npm run build
```

That produces `dist/cli.js`. Make `elv` runnable one of two ways. Either link it onto your PATH:

```bash
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

Search the vendored OpenAPI registry, inspect an operation, then copy a runnable example:

```bash
elv ops search "text to speech"
elv ops get text_to_speech_full
elv ops schema text_to_speech_full --example
```

The `--example` flag prints an `elv call` skeleton with the parameter shape filled in. Edit and run it. And `elv <command> --help` lists that command's own flags.

### Aliases

The twelve aliases are sugar over the same runner as `call`.

| Alias | Purpose |
| --- | --- |
| `tts` | Text-to-speech (voice id or name, text or file, optional stream and timestamps) |
| `stt` | Speech-to-text transcription |
| `music` | Text-to-music generation |
| `sfx` | Text-to-sound-effects generation |
| `voice-change` | Speech-to-speech voice conversion |
| `voice-isolate` | Background-noise removal |
| `dubbing` | Dubbing create, get, and audio workflows |
| `voices` | Voice list, search, get, clone |
| `agents` | ElevenAgents create, read, update, simulate |
| `models` | List available models |
| `history` | Generated-audio history list, audio, delete |
| `usage` | Subscription balance or date-range character stats |

```bash
elv tts --voice-id JBFqnCBsd6RMkjVDRZzb --text "Hello from elv." --out ./out
elv voices list
elv usage --from 2026-06-01 --to 2026-06-25
elv dubbing get --id abc123
```

### The generic runner

For anything outside the alias surface, call any operation by id. The `--json` body uses the bucketed shape (`path`, `query`, `body`), and `--path key=value` is a shorthand for single path parameters.

```bash
elv call text_to_speech_full \
  --json '{"path":{"voice_id":"JBFqnCBsd6RMkjVDRZzb"},"body":{"text":"Hello.","model_id":"eleven_v3"}}' \
  --out ./out

elv call delete_voice --path voice_id=VOICE_ID --yes
```

Large or paginated results never flood stdout. The list aliases (`voices list`, `history list`, `agents list`, `dubbing list`) and `call`/`http` take `--limit <n>` (sets the page size and caps what gets inlined), `--all` to fetch every page to disk (requires `--save-json`/`--out`), and `--save-json <path>` to write the full result somewhere you choose. A large single page spills to disk but still returns the `next` page command inline so you can keep paging. Inspect any spilled file without loading it into context with `elv view <path> [--path <dotted>] [--limit <n>]`.

### Escape hatches

When an endpoint is missing from the registry, still in beta, or needs a raw path, drop down to the primitives.

```bash
# Arbitrary REST against the configured base URL.
elv http GET /v1/user
elv http POST /v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb \
  --body-json '{"text":"Hi","model_id":"eleven_v3"}' --out ./out

# Scripted WebSocket session (catalog name or raw wss:// URL).
elv ws tts-realtime --query voice_id=VOICE --query model_id=eleven_flash_v2_5 \
  --send script.ndjson --out ./session

# Poll an operation until a status field resolves.
elv wait --operation get_dubbed_metadata \
  --json '{"path":{"dubbing_id":"abc"}}' \
  --status-path '$.data.status' \
  --success 'dubbed' --failure 'failed' \
  --interval-ms 2000 --timeout-ms 600000
```

## Configuration and auth

Set `ELEVENLABS_API_KEY` and `elv` sends it as the `xi-api-key` header. Never pass the key as a CLI argument: it never appears in output, dry-run previews, debug logs, or files, and keeping it in the environment keeps it that way.

```bash
export ELEVENLABS_API_KEY=your_key_here
elv config get
elv config doctor
```

`elv config doctor` checks the things that usually go wrong: API key present, base URL set, the registry cache, output-directory writability, Node version, base-URL reachability, and your credit balance.

Named profiles let you keep more than one setup. A config file at `.elv/config.json` (in the working directory) or `~/.config/elv/config.json` can define profiles with a base URL, an output directory, a default model, a default `max_credits`, and the name of the environment variable that holds the key. The config file stores the variable name, not the secret itself, so nothing sensitive lands on disk. Select a profile with `--profile <name>` or `ELV_PROFILE`.

A few environment variables and flags adjust the rest. `--base-url` or `ELEVENLABS_BASE_URL` overrides the endpoint, `ELEVENLABS_API_RESIDENCY` (`us`, `eu`, `in`, `sg`) picks a residency host, `ELV_OUTPUT_DIR` changes where output spills (default `~/.cache/elv/out`), and `ELV_CACHE_DIR` changes where the compiled spec registry is cached (default `~/.cache/elv`).

## Safety and budget

There are no interactive prompts, so anything with a side effect has to be confirmed explicitly. Destructive operations (DELETE), outbound calls and messages, API-key mutation, and member changes all require `--yes`. Reads are never gated.

```bash
elv call delete_voice --path voice_id=VOICE_ID --yes
```

Credit-consuming calls can be capped before they run. With `--max-credits` (or `ELV_MAX_CREDITS`, or a profile default), `elv` estimates the cost and, if it exceeds the ceiling, fails with exit 5 before touching the network. The estimates are calibrated against real charges: TTS Flash and Turbo run about 0.5 credits per character, standard models about 1.0, and speech-to-text about 27 credits per minute of audio.

```bash
elv tts --voice-id VOICE --text "Long script..." --max-credits 500 --out ./out
```

`--dry-run` validates the request and returns a redacted preview without calling the network. It runs before the `--yes` and budget gates, and the envelope reports `would_require_yes` and `would_exceed_budget` so you can see what a real run would hit. One caution: do not dry-run a secret-create operation with a real secret value, because redaction is keyed on field names and may echo a secret passed in the body. The full agent protocol is in [AGENTS.md](./AGENTS.md).

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
```

Synthesize speech and get the file back with a real charge from the response header:

```bash
elv tts --voice-id JBFqnCBsd6RMkjVDRZzb --text "Hello" --model eleven_flash_v2_5 --out out.mp3
# {"v":1,"ok":true,"files":[{"path":"out.mp3","mime":"audio/mpeg","bytes":...,"sha256":"..."}],
#  "cost":{"credits_estimated":...,"credits_charged":...,"credits_source":"header"}}
```

Transcribe audio:

```bash
elv stt --file note.m4a --model scribe_v1
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
