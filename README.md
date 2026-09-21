# elv

An agent-first ElevenLabs CLI. One JSON envelope per command, with the published REST API behind it.

Independent project; not affiliated with or endorsed by ElevenLabs.

## Why this exists

Agents need predictable inputs, small outputs, and a way to discover unfamiliar API operations without writing a new wrapper each time.

So we built `elv`: a simple, token-efficient, agent-first CLI over ElevenLabs' published API. The vendored September 21, 2026 OpenAPI document contains 391 operations; `elv` compiles 390 of them and deliberately skips one deprecated signed-URL route whose replacement is available. Each command returns one JSON envelope and an exit code an agent can branch on before parsing the result.

## What is this?

`elv` compiles the ElevenLabs OpenAPI spec into a command surface for agents. Speech, transcription, dialogue, music, sound effects, image/video generation, assets, dubbing, voices, conversations, and workspace operations share one runner. Named WebSocket clients handle realtime speech, dialogue, transcription, and conversations. [API coverage and its boundaries](./docs/api-coverage.md) distinguish the published contract from live provider verification.

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

The generic runner, `elv call <operation_id> --json '{...}'`, can invoke all 390 operations compiled from the pinned OpenAPI document. Nothing is hidden behind a hand-written subset. Escape hatches cover published endpoints that have not reached the pinned registry yet: `elv http <METHOD> <path>` makes an arbitrary REST call against the configured base URL, `elv ws <catalog|url>` runs a scripted WebSocket session, and `elv wait` polls an operation until a status field resolves. Known raw REST requests inherit registry metadata. Otherwise, safety and budget behavior depends on what protocol information is available.

Thin aliases wrap common workflows: `tts`, `stt`, `music`, `sfx`, `voice-change`, `voice-isolate`, `dubbing`, `dubbing-project`, `voices`, `agents`, `models`, `history`, `usage`, `workspace`, `flows`, and `assets`. Each builds an input and calls the same runner as `call`. Discovery is built in too: `elv capabilities` reports the machine contract and service map; `elv ops list`, `ops search`, `ops get`, and `ops schema` inspect the registry; and `elv spec status`, `spec diff`, and `spec update` expose and refresh the active spec provenance.

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
| `dubbing-project` | Dubbing v2 source and target transcript editing, including atomic bulk updates |
| `voices` | Voice list/filter, accents, search, get, clone, and confirmed replication |
| `agents` | ElevenAgents lifecycle, Procedures, tests, test runs, and RAG diagnostics |
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
elv agents procedures list --agent-id AGENT_ID --branch-id BRANCH_ID
elv voices accents --language en
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

For anything outside the alias surface, call any operation by id. The September 21 contract adds `post_agent_hold_audio_route`, `delete_agent_hold_audio_route`, and `list_phone_numbers_page_route`. Use `agents hold-audio upload|delete` for the hold-audio routes; the paged phone-number list is available through the generic runner as `elv call list_phone_numbers_page_route`, including its standard pagination flags. The generic `--json` input uses the bucketed shape (`path`, `query`, `body`); aliases take the request body directly. `--path key=value` is a shorthand for path parameters.

```bash
# Discover a generation model's input contract before spending credits.
elv ops schema create_image_generation --example
elv flows image create --json-file image-request.json --dry-run
elv flows image create --json-file image-request.json --wait
elv assets upload --file reference.png
elv agents tickets list --agent-id AGENT --status open
elv agents conversations summary --conversation-id CONVERSATION
```

Flows generation costs depend on the selected model and options. A configured credit ceiling blocks these operations when no defensible estimate is available, even with `--yes`. Completed generations and Assets carry signed content URLs: full responses go to private `sensitive: true` files, while redacted IDs, status, and cursors remain available for polling and pagination.

```bash
elv call text_to_speech_full \
  --json '{"path":{"voice_id":"JBFqnCBsd6RMkjVDRZzb"},"body":{"text":"Hello.","model_id":"eleven_v3"}}' \
  --out ./out

elv call export_batch_call \
  --json '{"path":{"batch_id":"BATCH_ID"}}' \
  --out ./batch-export

elv call list_procedures_route \
  --json '{"path":{"agent_id":"AGENT_ID","branch_id":"BRANCH_ID"}}'

elv call replicate_voice_to_isolated_environment \
  --json '{"path":{"voice_id":"VOICE_ID"},"body":{"target_workspace_id":"WORKSPACE_ID"}}' \
  --dry-run

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

# Realtime STT accepts send_audio_file actions and published query fields.
elv ws stt-realtime --query entity_detection=true \
  --send transcribe.ndjson --out ./session --dry-run

# Conversation monitoring is receive-only without --send; outbound controls require --yes.
elv ws convai-monitor --query conversation_id=CONVERSATION_ID --out ./monitor

# Poll an operation until a status field resolves.
elv wait --operation get_dubbed_metadata \
  --json '{"path":{"dubbing_id":"abc"}}' \
  --status-path '$.data.status' \
  --success 'dubbed' --failure 'failed' \
  --interval-ms 2000 --timeout-ms 600000
```

The WebSocket catalog contains `tts-realtime`, `tts-multi`, `ttd-realtime`, `ttd-multi`, `stt-realtime`, `convai`, and `convai-monitor`. Dialogue sessions use a voices initialization message and `inputs` arrays, not TTS's initial space. TTD supports v3 dialogue models; the older TTS protocol rejects `eleven_v3`. Multi-context audio is saved separately with context-to-file mappings in the result. `--dry-run`, `--yes`, and `--max-credits` apply; a ceiling rejects STT and agent sessions whose cost cannot be bounded.

Queued `convai` calls emit `queue_status` events with `waiting`, `admitted`, or `timed_out`; configured hold audio arrives as ordinary `audio` events. Configure the clip with `agents hold-audio`.

Use `--token-env TOKEN_VARIABLE` for single-use authentication and `--url-env URL_VARIABLE` for a signed WebSocket URL. Neither secret needs to appear in argv. `--token-env` only works against the configured API host, because the token travels in the connection URL; reach any other host through a signed `--url-env` URL, which carries its own credential. `elv ws --list` shows each route's protocol, duplex support, first message, and terminal rule. Agent audio of an undeclared encoding is written as `audio.bin` with a `ws_audio_format_unknown` warning unless the session sets `output_format`. STT's `send_audio_file` action wraps PCM bytes in the published JSON audio-chunk message:

```json
{"type":"send_audio_file","path":"audio.pcm","sample_rate":16000,"commit":true}
```

`send_binary_file` is reserved for unknown raw protocols. Known URL paths inherit their catalog's safety and budget rules, without forwarding your profile key to an arbitrary host.

Agents can answer live tool calls with `elv ws convai --duplex --query agent_id=AGENT --yes --out ./session`. All catalog protocols also accept live stdin with `--duplex`: send wrapped NDJSON actions and consume redacted events on stderr; stdout still contains one final envelope. Events are written to stderr synchronously so none are lost at exit, which means the caller must keep draining stderr: a session whose stderr pipe is never read blocks until it is. Initial `--send` actions can seed a live session. Dynamic speech, dialogue, transcription, and conversation costs cannot be bounded, so configured credit ceilings block those sessions before connection. EOF closes the transport; send the protocol's flush/end controls and wait for final events before closing stdin if queued output matters.

### Music detailed streaming

For non-streaming audio plus composition metadata, use
`elv call compose_detailed --json-file request.json --out ./song`.
The CLI splits the multipart response into audio and JSON files. Always use the
returned `files[].path`: existing files are preserved, collisions get distinct
names, and credential files receive a `.sensitive` marker even with an explicit
output filename. Multi-file operations require an output directory.

Atomic publication requires a filesystem that supports same-directory hard links.
Unsupported filesystems fail rather than falling back to replacing existing files.
The release gate is verified on Linux with Node 22 and 26.

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

One asymmetry is deliberate. A `.elv/config.json` that `elv` finds implicitly in the current directory can set ordinary workflow options, but it cannot set `base_url` or `api_key_env` — otherwise cloning a repository would be enough to point your credentials at someone else's endpoint. Choose an endpoint or key variable deliberately: put it in your user config, or set `ELV_CONFIG` to the exact file you mean. The whole project file is refused if it contains either privileged field; remove those fields before using `--base-url`.

Implicit project settings overlay the trusted user profile's workflow options (`output_dir` and `default_model_id`). A project's `default_profile` selects only its own workflow settings, never a trusted credential or endpoint profile. The trusted profile comes from `--profile`, then `ELV_PROFILE`, then the user config's default. Project `max_credits` may lower a trusted ceiling, but cannot raise or remove it; invalid project ceilings are refused. Explicit `--max-credits` and `ELV_MAX_CREDITS` still override deliberately. `ELV_CONFIG` explicitly trusts and selects that one file instead of this overlay.

A few environment variables and flags adjust the rest. `--base-url` or `ELEVENLABS_BASE_URL` overrides the endpoint, and `ELEVENLABS_API_RESIDENCY` (`us`, `eu`, `in`, `sg`) picks a residency host.

Paths follow the XDG base directories, with the historical home-relative path as the fallback and an `ELV_*` override always winning:

| What | Override | Default |
| ---- | -------- | ------- |
| Config | `ELV_CONFIG` (an exact file) | `$XDG_CONFIG_HOME/elv/config.json`, else `~/.config/elv/config.json` |
| Registry cache | `ELV_CACHE_DIR` | `$XDG_CACHE_HOME/elv`, else `~/.cache/elv` |
| Output | `--out` per command, then `ELV_OUTPUT_DIR`, then a profile's `output_dir` | `$XDG_DATA_HOME/elv/out`, else `~/.local/share/elv/out` |

Generated files are durable, so output lives in a data directory rather than a cache directory — clearing a cache should never delete your audio. Anything already written under the older `~/.cache/elv/out` default stays there; `elv` moves nothing. Run `elv config get` to see the paths actually in effect.

## Models

`elv models list` returns the models visible to the authenticated account from `GET /v1/models`. It is not an exhaustive catalog across every ElevenLabs product: STT, realtime STT, Sound Effects, Text to Voice, and Music model IDs are documented on other API surfaces and may not appear in that response. Alias `--model` values pass through as strings so provider-enabled models do not require a CLI release. A profile's `default_model_id` applies to TTS REST and named TTS WebSocket calls when no model is supplied.

The official model references retrieved on September 21, 2026 list these current families and examples:

| Area | Model IDs |
| --- | --- |
| Text to Speech | `eleven_v3`, `eleven_multilingual_v2`, `eleven_flash_v2_5`, `eleven_flash_v2` |
| Text to Voice | `eleven_ttv_v3`, `eleven_multilingual_ttv_v2` |
| Speech to Speech | `eleven_multilingual_sts_v2`, `eleven_english_sts_v2` |
| Speech to Text | `scribe_v2`, `scribe_v2_medical` (batch only), `scribe_v2_realtime` |
| Sound Effects | `eleven_text_to_sound_v2` |
| Music | `music_v2_5`, `music_v2`, `music_v1` |
| Image generation (flows) | `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst` |
| Agent LLMs (examples) | `gemini-3.8-flash`, `gpt-6-astra` |

ElevenLabs marks `eleven_turbo_v2_5`, `eleven_turbo_v2`, and `scribe_v1` deprecated. Use `eleven_flash_v2_5`, `eleven_flash_v2`, and `scribe_v2` respectively. `music_v2_5` is the current product default, but the API's `MusicModelID` default remains `music_v1`; pass `--model music_v2_5` explicitly when that choice matters. The agent LLM enum is longer than the two September additions shown here. Model availability still depends on the account, region, plan, and rollout. See [API coverage](./docs/api-coverage.md) for the pinned source and limits.

## Safety and budget

There are no interactive prompts, so anything with a side effect has to be confirmed explicitly. Destructive operations (DELETE), outbound calls and messages, cross-residency voice replication, API-key mutation, and member changes all require `--yes`. Reads are never gated.

```bash
elv call delete_voice --path voice_id=VOICE_ID --yes
```

Credit-consuming calls can be capped before they run. With `--max-credits` (or `ELV_MAX_CREDITS`, or a profile default), `elv` estimates supported operations and fails with exit 5 before touching the network when the estimate exceeds the ceiling. It also fails closed for generation operations and STT or agent WebSocket sessions whose cost cannot be bounded. A raw or non-generation operation with unknown cost reports `unknown_unbounded`; its ceiling is not a guarantee.

Current estimates use about 0.5 credits per character for TTS Flash and Turbo, 1.0 for other TTS models, and about 27 credits per minute for speech-to-text. Music uses a conservative five-minute cap when generated length is unknown. Treat every estimate as a pre-flight guard, not an invoice; provider response headers remain the source for charged credits when available.

Before dry-run, confirmation, budget checks, or network access, file-emitting commands verify that `--out`, `--save-json`, or the configured default output directory is writable; `invalid_out_target` exits 2 with a replacement-target hint. Speech-to-text likewise fails before network access unless exactly one media source is supplied: `stt --file PATH`, generic `--file file=PATH`, `body.source_url`, or `body.cloud_storage_url`.

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
#  "files":[{"path":"~/.local/share/elv/out/get_user_voices_v2-response.json",...}],
#  "data_summary":{...},"hints":[{"cmd":"elv view '<path>' --path 'voices'",...}]}

# Then inspect it without loading the whole file into context:
elv view ~/.local/share/elv/out/get_user_voices_v2-response.json --path voices --limit 3

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
# transcript spilled to ~/.local/share/elv/out/, cost includes the real credits_charged
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

One command runs everything that has to pass:

```bash
npm run gate
```

That is `scripts/gate.sh` — format check, lint, typecheck, build, tests, and the offline envelope smoke matrix, fail-fast in that order. Run the individual scripts while iterating if you like; the gate is what must be green. `npm run format` applies the formatter, and `ELV_TEST_MAX_WORKERS=<n>` adjusts the test run's worker ceiling for one run.

Two checks reach past the source tree. `npm run smoke:pack` installs an `npm pack` tarball offline into a throwaway prefix and smokes it, which is what proves `dependencies` is complete. `npm run verify:install` compares your build against the globally installed copy and reports the drift; see [AGENTS.md](./AGENTS.md) for both.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the workflow and conventions, and [SECURITY.md](./SECURITY.md) for how to report a vulnerability.

## License

MIT. See [LICENSE](./LICENSE).
