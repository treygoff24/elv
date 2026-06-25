# elv

Agent-first ElevenLabs CLI. Every command prints exactly one JSON envelope to stdout; binary output is written to disk and referenced in `files[]`.

## Quick start

```bash
npx eleven-agent-cli config get
export ELEVENLABS_API_KEY=your_key
npx eleven-agent-cli ops search "text to speech"
```

## The four questions

```text
What can I do?            → elv ops search
What does this op need?   → elv ops schema <id>
Run it.                   → elv call <id> / elv <alias>
Where did output go?      → files[] in the envelope
```

## Discovery

Search the vendored OpenAPI registry, inspect an operation, then copy a runnable example:

```bash
elv ops search "text to speech"
elv ops get text_to_speech_full
elv ops schema text_to_speech_full --example
```

The `--example` flag prints a ready-to-run `elv call` skeleton. Fill in parameters and run:

```bash
elv call text_to_speech_full \
  --json '{"path":{"voice_id":"21m00Tcm4TlvDq8ikWAM"},"body":{"text":"Hello from elv.","model_id":"eleven_v3"}}' \
  --out ./out
```

## Command surface

```bash
elv ops search <query> [--limit N]
elv ops get <operation_id>
elv ops schema <operation_id> [--raw] [--example]
elv call <operation_id> --json <json> [--file field=path] [--out dir|file] [--max-credits N] [--dry-run] [--yes]
elv http <method> <path> [--query k=v] [--body-json <json>] [--file field=path] [--out dir|file]
elv ws <catalog-name|path|url> [--query k=v] [--send events.ndjson] [--out dir]
elv wait --operation <id> --json <json> --status-path <jsonpath> --success <vals> --failure <vals> [--interval-ms] [--timeout-ms]
elv tts | stt | music | sfx | voice-change | voice-isolate | dubbing | voices | models | agents | history | usage ...
elv config get | doctor
elv spec update [--from <url|file>] [--offline]
elv view <file> [--jq <expr>]            # phase 2
```

Power commands: `ops`, `call`, `http`, `ws`. Aliases are sugar over the same runner.

## Escape hatches

When an endpoint is missing from the registry, still in beta, or needs a raw REST/WebSocket path, use the generic primitives. They share the same auth, envelope, retries, and redaction as `call`.

**HTTP** — arbitrary REST against the configured base URL:

```bash
elv http GET /v1/voices
elv http POST /v1/text-to-speech/21m00Tcm4TlvDq8ikWAM \
  --body-json '{"text":"Hi","model_id":"eleven_v3"}' --out ./out
```

**WebSocket** — scripted NDJSON sessions (catalog name or raw `wss://` URL):

```bash
elv ws tts-realtime --query voice_id=VOICE --query model_id=eleven_flash_v2_5 \
  --send script.ndjson --out ./session
```

**Wait** — poll an operation in-process until a status field resolves:

```bash
elv wait --operation get_dubbing \
  --json '{"path":{"dubbing_id":"abc"}}' \
  --status-path '$.data.status' \
  --success 'done,completed' --failure 'failed,error' \
  --interval-ms 2000 --timeout-ms 600000
```

## Exit codes

Branch on exit code without parsing JSON when possible:

| Code | Meaning |
|------|---------|
| 0 | Success |
| 2 | Input / validation (invalid parameters, local pre-flight) |
| 3 | Auth / permission |
| 4 | Confirmation required (`--yes` missing on destructive or external-side-effect op) |
| 5 | Budget ceiling (`--max-credits` blocked the call pre-flight) |
| 6 | Credit / quota exhausted at provider |
| 7 | Transient / retryable exhausted (429, 5xx after retries, network) |
| 8 | Provider error (other 4xx/5xx not covered above) |
| 9 | Not found (404, unknown `operation_id`) |

## Agent usage

See [AGENTS.md](./AGENTS.md) for the agent protocol: discovery, envelopes, safety flags, and spend caps.
