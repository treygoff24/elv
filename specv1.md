Here’s the buildable spec I’d hand to an implementation agent.

The core move is this: build a **small, agent-first CLI runtime over the ElevenLabs OpenAPI spec**, not a huge hand-written CLI that tries to mirror every endpoint manually. The CLI should expose every REST operation by `operationId`, provide a generic raw HTTP escape hatch for anything the spec misses, add first-class WebSocket and streaming primitives, and then layer maybe 8 to 12 ergonomic aliases on top for common workflows like TTS, STT, music, sound effects, voice isolation, dubbing, voice cloning, and agents.

ElevenLabs is moving fast. Their public API reference already spans ElevenAgents, conversations, users, tools, knowledge bases, tests, phone numbers, batch calling, LLMs, MCP, analytics, environment variables, text-to-speech, speech-to-text, music, speech engine, voices, dialogue, voice changer, voice design, sound effects, audio isolation, dubbing, forced alignment, pronunciation dictionaries, Audio Native, Studio, history, models, tokens, workspace usage, service accounts, API keys, webhooks, and legacy resources. A static CLI will rot. An OpenAPI-driven CLI will stay useful. ([ElevenLabs](https://elevenlabs.io/docs/api-reference/introduction))

## Product name

Use `elv`.

It is short, low-token, unambiguous enough, and not annoying in shell commands.

Package name can be `@your-org/elv` or `eleven-agent-cli`. Binary should be:

```bash
elv
```

## North-star behavior

`elv` is not a human CLI with some JSON flags. It is an **agent protocol over the shell**.

Every command must be deterministic, non-interactive, quiet by default, and return exactly one machine-readable JSON object. No spinners, no color, no progress bars, no prose banners, no “Done!” text. This aligns with current agent-CLI practice, where quiet JSON output is favored because verbose human output burns context, and it also matches the normal CLI principle that successful machine-consumable output should be on stdout while prompts, warnings, and errors are not stable script targets. ([Speakeasy](https://www.speakeasy.com/blog/engineering-agent-friendly-cli))

The CLI’s job is to let an agent answer four questions cheaply:

```text
What can I do?
What inputs does this operation need?
Run it.
Where did the output go?
```

## Key architectural decision

Build three layers.

Layer 1 is the **OpenAPI operation runner**. This is the complete coverage layer. It downloads or ships ElevenLabs’ OpenAPI 3.1 spec, compiles each REST operation into a compact local registry, validates inputs, constructs requests, sends them, normalizes responses, saves binary outputs to disk, and returns a stable JSON envelope. ElevenLabs exposes an OpenAPI document, and their docs say API access can happen through HTTP, WebSocket, or official SDKs. ([Eleven Labs](https://api.elevenlabs.io/openapi.json))

Layer 2 is the **generic escape hatch**. This is how you preserve “literally anything” even when the spec lags or a new beta endpoint appears. It supports arbitrary HTTP calls and arbitrary WebSocket sessions against the configured ElevenLabs base URL.

Layer 3 is the **agent ergonomics layer**. This is a small set of curated aliases and workflows that agents will use 80 percent of the time: `tts`, `stt`, `music`, `sfx`, `voice-change`, `voice-isolate`, `voices`, `models`, `agents`, `dubbing`, `history`, `usage`. Anthropic’s tool-use guidance recommends detailed tool descriptions and consolidating related actions into fewer tools rather than creating a separate surface for every action, and that same lesson applies here. ([Claude](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools))

Do not build hundreds of bespoke subcommands. Build a complete generic runner and a small, polished front door.

## Why not just use the official ElevenLabs MCP server?

ElevenLabs already provides agent tooling, including reusable Agent Skills and a local MCP server that lets tools like Claude, Cursor, Windsurf, and OpenAI Agents call ElevenLabs APIs through prompts. Their MCP server supports generating speech, cloning voices, transcribing audio, and other audio workflows, and it has useful output modes for files, resources, or both. ([ElevenLabs](https://elevenlabs.io/docs/eleven-api/resources/agent-tooling))

That is useful prior art, but it is not the same product. Trey wants a **CLI for shell-using agents** that can hit **the entire API surface**, not just a curated MCP toolset. The best design is to make `elv` independent, then optionally expose `elv mcp serve` later by wrapping the same core engine.

## CLI command surface

The entire CLI can be this small:

```bash
elv ops search <query>
elv ops get <operation_id>
elv ops schema <operation_id>
elv call <operation_id> --json <json> [--file field=path] [--out dir|file]
elv http <method> <path> [--query k=v] [--body-json <json>] [--file field=path] [--out dir|file]
elv ws <path-or-url> [--query k=v] [--send events.ndjson] [--out dir|file]
elv wait --cmd <elv-command-json-array> --status-path <json.path> --success <values> --failure <values>
elv tts ...
elv stt ...
elv music ...
elv sfx ...
elv voice-change ...
elv voice-isolate ...
elv dubbing ...
elv voices ...
elv models ...
elv agents ...
elv history ...
elv usage ...
elv config get
elv config doctor
elv spec update
```

That is enough. The power is in `ops`, `call`, `http`, and `ws`.

## Output contract

Every command returns exactly one JSON envelope to stdout. Even failures return JSON to stdout, with a nonzero exit code. Stderr is reserved for debug logs only when explicitly enabled. This is a deliberate agent-first choice, because subprocess wrappers often treat stderr as diagnostic junk, while the agent needs structured failure context to recover.

Successful response:

```json
{
  "ok": true,
  "cmd": "elv tts",
  "operation_id": "text_to_speech_full",
  "http": {
    "status": 200,
    "method": "POST",
    "path": "/v1/text-to-speech/{voice_id}"
  },
  "request": {
    "id": "request-id-from-provider-if-present",
    "trace_id": "x-trace-id-if-present"
  },
  "cost": {
    "character_cost": 123
  },
  "data": {
    "voice_id": "21m00Tcm4TlvDq8ikWAM",
    "model_id": "eleven_v3"
  },
  "files": [
    {
      "path": "/absolute/path/out/speech.mp3",
      "mime": "audio/mpeg",
      "bytes": 481293,
      "sha256": "..."
    }
  ],
  "truncated": false,
  "warnings": [],
  "hints": []
}
```

Failure response:

```json
{
  "ok": false,
  "cmd": "elv call text_to_speech_full",
  "operation_id": "text_to_speech_full",
  "http": {
    "status": 422,
    "method": "POST",
    "path": "/v1/text-to-speech/{voice_id}"
  },
  "error": {
    "type": "validation_error",
    "code": "invalid_parameters",
    "message": "The provider error message goes here.",
    "param": "model_id",
    "request_id": "provider-request-id-if-present"
  },
  "retry": {
    "recommended": false,
    "after_ms": null
  },
  "hints": [
    {
      "cmd": "elv ops schema text_to_speech_full",
      "why": "Inspect required params and accepted values."
    }
  ]
}
```

ElevenLabs error responses use standard HTTP status codes and a JSON `detail` object with fields like `type`, `code`, `message`, `request_id`, and `param`; 429s should use exponential backoff for rate limits, and concurrency errors should wait for current requests to complete. Preserve these details directly in the envelope. ([ElevenLabs](https://elevenlabs.io/docs/eleven-api/resources/errors))

ElevenLabs also exposes useful generation metadata in response headers, including `character-cost`, `request-id`, and `x-trace-id`. Capture those whenever present. ([ElevenLabs](https://elevenlabs.io/docs/api-reference/introduction))

## Input model

Canonical input to `elv call` should be explicit JSON:

```json
{
  "path": {
    "voice_id": "21m00Tcm4TlvDq8ikWAM"
  },
  "query": {
    "output_format": "mp3_44100_128"
  },
  "body": {
    "text": "Hello from an agent-first CLI.",
    "model_id": "eleven_v3"
  }
}
```

Command:

```bash
elv call text_to_speech_full \
  --json '{"path":{"voice_id":"21m00Tcm4TlvDq8ikWAM"},"query":{"output_format":"mp3_44100_128"},"body":{"text":"Hello from an agent-first CLI.","model_id":"eleven_v3"}}' \
  --out ./out
```

For convenience, allow flat JSON too:

```bash
elv call text_to_speech_full \
  --json '{"voice_id":"21m00Tcm4TlvDq8ikWAM","text":"Hello","model_id":"eleven_v3","output_format":"mp3_44100_128"}' \
  --out ./out
```

Flat JSON should be resolved by this precedence:

```text
path params first
query params second
body fields third
headers never, except explicit allowlisted headers
```

If a flat key is ambiguous, fail with a structured error and show the explicit JSON shape.

Support these input forms:

```bash
--json '{"body":{"text":"hi"}}'
--json-file request.json
--stdin-json
--query key=value
--path key=value
--file field=/path/to/file.mp3
--file samples[]=/path/a.wav
--file samples[]=/path/b.wav
```

Never require agents to construct multipart boundaries themselves. The CLI owns that.

## Binary and large response handling

Default behavior: never emit binary data or base64 to stdout.

For binary responses, save the file and return a file record. ElevenLabs returns audio for many operations, including text-to-speech, sound generation, audio isolation, voice samples, history audio, and streaming variants. The OpenAPI response content types should drive whether an operation is treated as binary. ([Eleven Labs](https://api.elevenlabs.io/openapi.json))

Rules:

```text
If response is JSON under 32 KB: include data inline.
If response is JSON over 32 KB: include data_summary inline and save full JSON to file.
If response is binary: save to file and include files[] only.
If response is stream: save stream to file unless --events is requested.
If response is zip: save zip, do not unpack unless --unpack is set.
```

Large JSON envelope:

```json
{
  "ok": true,
  "data_summary": {
    "type": "array",
    "count": 1000,
    "preview_count": 20,
    "preview": []
  },
  "files": [
    {
      "path": "/abs/out/full-response.json",
      "mime": "application/json",
      "bytes": 920312
    }
  ],
  "truncated": true,
  "hints": [
    {
      "cmd": "elv view /abs/out/full-response.json --jq '.items[0]'",
      "why": "Inspect saved full response without loading it into context."
    }
  ]
}
```

Add a tiny `elv view` helper if you want, but it can be phase two.

## Discovery commands

Agents need to explore without dumping the entire API reference into context. Discovery is therefore part of the product.

```
elv ops search
elv ops search "create speech"
```

Returns max 10 compact matches:

```json
{
  "ok": true,
  "query": "create speech",
  "matches": [
    {
      "operation_id": "text_to_speech_full",
      "method": "POST",
      "path": "/v1/text-to-speech/{voice_id}",
      "summary": "Text To Speech",
      "required": ["voice_id", "text"],
      "returns": "audio",
      "cmd": "elv ops schema text_to_speech_full"
    }
  ]
}
elv ops get
elv ops get text_to_speech_full
```

Returns a compact operation card:

```json
{
  "ok": true,
  "operation": {
    "operation_id": "text_to_speech_full",
    "group": "text_to_speech",
    "method": "POST",
    "path": "/v1/text-to-speech/{voice_id}",
    "summary": "Converts text into speech using a voice of your choice and returns audio.",
    "content_type": "application/json",
    "returns": "audio/mpeg",
    "required": {
      "path": ["voice_id"],
      "body": ["text"]
    },
    "optional": {
      "query": ["enable_logging", "output_format"],
      "body": ["model_id", "voice_settings", "seed", "previous_text", "next_text"]
    },
    "examples": [
      {
        "cmd": "elv call text_to_speech_full --json '{...}' --out ./out"
      }
    ]
  }
}
elv ops schema
```

Returns the full compact schema, not the raw OpenAPI fragment by default. Raw is available with `--raw`.

This is the agent equivalent of `--help`, but structured.

## OpenAPI compiler

Add a build-time and runtime compiler.

Source:

```text
https://api.elevenlabs.io/openapi.json
```

Internal compiled registry shape:

```ts
type OperationCard = {
  operationId: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  pathTemplate: string;
  group: string[];
  summary?: string;
  description?: string;
  tags: string[];
  risk: "read" | "generate" | "mutate" | "destructive" | "external_side_effect";
  pathParams: ParamCard[];
  queryParams: ParamCard[];
  headerParams: ParamCard[];
  requestBody?: BodyCard;
  responses: ResponseCard[];
  returnsBinary: boolean;
  returnsJson: boolean;
  streaming: boolean;
  deprecated: boolean;
  examples: ExampleCard[];
};
```

Compile steps:

```text
1. Fetch OpenAPI JSON.
2. Dereference local $refs.
3. Extract each path + method.
4. Preserve operationId exactly.
5. Derive group from x-fern-sdk-group-name, tags, or path.
6. Extract path/query/header params.
7. Extract request body content types.
8. Detect multipart fields.
9. Detect binary responses from response content types and schema format=binary.
10. Detect streaming from x-fern-streaming or known streaming paths.
11. Generate compact schemas for agent display.
12. Generate risk labels.
13. Save registry to ~/.cache/elv/openapi.compact.json.
14. Save raw spec too for --raw and debugging.
```

ElevenLabs’ breaking-change policy explicitly says additive response fields are not breaking and clients are required to ignore unrecognized response fields, while removing fields, changing structure, adding required params, changing param types, or removing paths is breaking. So the implementation must be lenient on responses and stricter on requests. Also add `elv spec update` because ElevenLabs says API updates are published on a weekly cadence. ([ElevenLabs](https://elevenlabs.io/docs/eleven-api/resources/breaking-changes-policy))

## Request runner

Pseudo-flow:

```ts
async function runOperation(operationId: string, input: AgentInput): Promise<Envelope> {
  const registry = await loadRegistry();
  const op = registry.get(operationId);
  if (!op) return errUnknownOperation(operationId);

  const normalized = normalizeInput(op, input);
  const validation = validateInput(op, normalized);
  if (!validation.ok) return errValidation(validation);

  enforceNonInteractiveSafety(op, input);

  const req = buildHttpRequest(op, normalized);
  const res = await sendWithRetry(req, op);
  return normalizeResponse(op, res);
}
```

Retry policy:

```text
Retry GET, HEAD, and explicitly idempotent operations on 429, 500, 502, 503, 504.
Retry POST only when --retry-post is set or the operation is known safe.
Use exponential backoff with jitter.
Honor Retry-After if present.
Do not retry validation, auth, authorization, payment, or not_found errors.
```

## Generic HTTP escape hatch

This preserves total coverage when docs and OpenAPI disagree.

Examples:

```bash
elv http GET /v1/voices
elv http POST /v1/text-to-speech/21m00Tcm4TlvDq8ikWAM \
  --query output_format=mp3_44100_128 \
  --body-json '{"text":"Hello","model_id":"eleven_v3"}' \
  --out ./out
elv http POST /v1/audio-isolation \
  --file audio=/tmp/noisy.mp3 \
  --out ./out
```

It should still use the same auth, output envelope, retries, binary handling, and error normalization.

## Generic WebSocket primitive

OpenAPI alone is not enough because ElevenLabs exposes important real-time APIs through WebSockets, including real-time TTS, multi-context WebSocket, real-time speech-to-text, and Speech Engine style flows. Their docs explicitly list WebSocket and streaming guidance across those capabilities. ([ElevenLabs](https://elevenlabs.io/docs/api-reference/introduction))

Add:

```bash
elv ws <path-or-url> \
  --query key=value \
  --send events.ndjson \
  --out ./out/session
```

Input event file is newline-delimited JSON:

```json
{"type":"send","data":{"text":"Hello "}}
{"type":"send","data":{"text":"world."}}
{"type":"send","data":{"text":""}}
{"type":"close"}
```

Output should save:

```text
session/events.received.ndjson
session/audio.mp3 or audio.pcm if applicable
session/manifest.json
```

Envelope:

```json
{
  "ok": true,
  "cmd": "elv ws",
  "ws": {
    "path": "/v1/...",
    "events_sent": 4,
    "events_received": 19,
    "closed": true
  },
  "files": [
    {
      "path": "/abs/session/events.received.ndjson",
      "mime": "application/x-ndjson"
    },
    {
      "path": "/abs/session/audio.mp3",
      "mime": "audio/mpeg"
    }
  ]
}
```

Add curated aliases later:

```bash
elv tts realtime --voice-id ... --text-file script.txt --out ./out
elv stt realtime --audio input.wav --out ./out
```

## Curated aliases

These are thin wrappers over `call`, `http`, or `ws`. They must never become a second implementation.

### `elv tts`

```bash
elv tts \
  --voice-id 21m00Tcm4TlvDq8ikWAM \
  --text "Hello." \
  --model eleven_v3 \
  --format mp3_44100_128 \
  --out ./out
```

Also:

```bash
elv tts --voice "Rachel" --text-file script.txt --out speech.mp3
elv tts --timestamps --voice-id ... --text-file script.txt --out ./out
elv tts stream --voice-id ... --text-file script.txt --out ./out
```

Resolution behavior:

```text
If --voice-id is provided, use it.
If --voice is provided, call voices list/search, resolve exact or fail with candidates.
If --model omitted, use configurable default.
If --out is a directory, generate deterministic filename.
```

### `elv stt`

```bash
elv stt --file audio.mp3 --model scribe_v2 --out transcript.json
```

Options:

```text
--timestamps none|word|character
--diarize
--language <code>
--webhook <url>
--wait
```

### `elv music`

```bash
elv music --prompt "30 second lo-fi loop, warm, no vocals" --out ./out
elv music stream --prompt-file prompt.txt --out ./out
```

### `elv sfx`

```bash
elv sfx --prompt "Wooden door creaks open, then soft slam" --duration 3 --out ./out
```

### `elv voice-change`

```bash
elv voice-change --voice-id ... --file input.wav --out ./out
```

### `elv voice-isolate`

```bash
elv voice-isolate --file noisy.mp3 --out clean.mp3
```

### `elv dubbing`

```bash
elv dubbing create --file video.mp4 --source en --target es --wait --out ./out
elv dubbing get --id <dubbing_id>
elv dubbing audio --id <dubbing_id> --language es --out ./out
```

### `elv voices`

```bash
elv voices list --limit 20
elv voices find "Juniper"
elv voices get --voice-id ...
elv voices clone-instant --name "..." --file sample.wav
```

### `elv agents`

```bash
elv agents list
elv agents get --agent-id ...
elv agents create --json-file agent.json
elv agents update --agent-id ... --json-file patch.json
elv agents simulate --agent-id ... --text "..."
```

ElevenLabs’ API reference includes extensive ElevenAgents operations, including agent CRUD, branch/versioning/deployments, simulations, conversation search and analysis, tags, tools, knowledge base docs, tests, phone numbers, widget settings, secrets, telephony, WhatsApp, batch calling, LLMs, MCP servers, analytics, and environment variables, so the curated `agents` namespace should stay shallow and rely on `elv call` for the long tail. ([ElevenLabs](https://elevenlabs.io/docs/api-reference/introduction))

### `elv history`

```bash
elv history list --limit 20
elv history audio --id <history_item_id> --out ./out
elv history delete --id <history_item_id> --yes
```

### `elv usage`

```bash
elv usage
elv usage --from 2026-06-01 --to 2026-06-25
```

## Safety model

No prompts. Ever.

Prompting breaks agents and scripts; CLI guidance says prompts should only be used when stdin is an interactive TTY, and this CLI is not designed for interactive human operation. ([clig.dev](https://clig.dev/))

Instead:

```text
DELETE operations require --yes.
Operations classified external_side_effect require --yes.
API key deletion, disabling, workspace member removal, phone calls, WhatsApp outbound messages, and batch calls require --yes.
All commands support --dry-run, which prints the request envelope without network execution.
```

Failure example:

```json
{
  "ok": false,
  "error": {
    "type": "confirmation_required",
    "code": "destructive_operation_requires_yes",
    "message": "This operation is classified as destructive. Re-run with --yes to execute."
  },
  "hints": [
    {
      "cmd": "elv call delete_agent --json-file request.json --yes"
    }
  ]
}
```

Security defaults:

```text
Read API key only from ELEVENLABS_API_KEY or configured secret provider.
Do not accept API keys in positional args.
Redact xi-api-key, Authorization, cookies, and webhook secrets from all logs and dry-runs.
Use service-account API keys per environment.
Support --base-url for private deployments or data residency.
Support profiles, but do not store raw API keys in config unless using OS keychain.
```

ElevenLabs’ own security guidance recommends service accounts for scoped API-only access, separate service accounts per environment, least privilege, observability by environment, and resource-level permission checks in your own backend for voice access. ([ElevenLabs](https://elevenlabs.io/docs/eleven-api/guides/how-to/best-practices/security))

## Config

Environment variables:

```bash
ELEVENLABS_API_KEY
ELEVENLABS_BASE_URL
ELEVENLABS_API_RESIDENCY
ELV_PROFILE
ELV_OUTPUT_DIR
ELV_CACHE_DIR
ELV_SPEC_URL
ELV_NO_NETWORK_SPEC_UPDATE
ELV_DEBUG
```

Config file:

```json
{
  "default_profile": "prod",
  "profiles": {
    "prod": {
      "base_url": "https://api.elevenlabs.io",
      "api_key_env": "ELEVENLABS_API_KEY",
      "output_dir": "./.elv/out",
      "default_model_id": "eleven_v3"
    },
    "test": {
      "base_url": "https://api.elevenlabs.io",
      "api_key_env": "ELEVENLABS_TEST_API_KEY",
      "output_dir": "./.elv/test-out"
    }
  }
}
```

`elv config doctor` should verify:

```text
API key exists.
Base URL is reachable.
OpenAPI registry exists.
Spec age.
Output dir is writable.
Node version is supported.
```

## File layout

Use TypeScript on Node 22+. This gives easy `npx` use, native `fetch`, good JSON tooling, and a clean path to publish one executable package.

Repository:

```text
elv/
  package.json
  tsconfig.json
  README.md
  AGENTS.md
  src/
    cli.ts
    commands/
      ops.ts
      call.ts
      http.ts
      ws.ts
      wait.ts
      config.ts
      aliases/
        tts.ts
        stt.ts
        music.ts
        sfx.ts
        voice-change.ts
        voice-isolate.ts
        dubbing.ts
        voices.ts
        models.ts
        agents.ts
        history.ts
        usage.ts
    core/
      client.ts
      request-builder.ts
      response-normalizer.ts
      envelope.ts
      errors.ts
      retries.ts
      files.ts
      config.ts
      safety.ts
      redaction.ts
    openapi/
      fetch-spec.ts
      compile-spec.ts
      compact-schema.ts
      registry.ts
      risk.ts
    ws/
      session.ts
      events.ts
      audio-writer.ts
    util/
      json.ts
      paths.ts
      hash.ts
  fixtures/
    fake-openapi.json
  tests/
    cli-json.test.ts
    openapi-compiler.test.ts
    request-builder.test.ts
    response-normalizer.test.ts
    multipart.test.ts
    safety.test.ts
    retries.test.ts
    aliases.test.ts
```

Recommended dependencies:

```json
{
  "dependencies": {
    "commander": "^14",
    "ajv": "^8",
    "yaml": "^2",
    "mime-types": "^2",
    "ws": "^8",
    "zod": "^4"
  },
  "devDependencies": {
    "typescript": "^5",
    "tsx": "^4",
    "tsup": "^8",
    "vitest": "^3"
  }
}
```

Keep dependencies boring. No framework circus.

## Internal modules

### `core/envelope.ts`

Defines the stable output schema. Every command must go through this.

```ts
type Envelope =
  | SuccessEnvelope
  | ErrorEnvelope;

type SuccessEnvelope = {
  ok: true;
  cmd: string;
  operation_id?: string;
  http?: HttpMeta;
  ws?: WsMeta;
  request?: RequestMeta;
  cost?: CostMeta;
  data?: unknown;
  data_summary?: unknown;
  files?: FileMeta[];
  truncated?: boolean;
  warnings: Hint[];
  hints: Hint[];
};

type ErrorEnvelope = {
  ok: false;
  cmd: string;
  operation_id?: string;
  http?: HttpMeta;
  error: {
    type: string;
    code: string;
    message: string;
    param?: string | null;
    request_id?: string | null;
    raw?: unknown;
  };
  retry?: {
    recommended: boolean;
    after_ms?: number | null;
  };
  hints: Hint[];
};
```

### `core/client.ts`

Owns auth, base URL, headers, fetch, retry.

```ts
type ClientRequest = {
  method: string;
  pathOrUrl: string;
  query?: Record<string, string | number | boolean | null>;
  headers?: Record<string, string>;
  body?: BodyInit;
  timeoutMs?: number;
};
```

Always inject:

```text
xi-api-key: process.env[api_key_env]
```

Never print it.

### `core/request-builder.ts`

Converts normalized input into HTTP request.

Responsibilities:

```text
Substitute path params.
Serialize query params.
Serialize JSON body.
Serialize multipart/form-data body.
Attach files.
Set content-type only when needed.
Reject unknown required params.
Preserve unknown optional body fields if --allow-unknown is set.
```

### `core/response-normalizer.ts`

Responsibilities:

```text
Read status.
Read headers.
Capture character-cost, request-id, x-trace-id.
Detect JSON vs binary vs text.
Save binary to file.
Save large JSON to file.
Parse ElevenLabs error detail.
Build envelope.
```

### `openapi/compact-schema.ts`

Agents do not want raw OpenAPI unless debugging. Produce a compact schema:

```json
{
  "required": {
    "path": {
      "voice_id": "string"
    },
    "body": {
      "text": "string"
    }
  },
  "optional": {
    "query": {
      "output_format": {
        "type": "string",
        "enum": ["mp3_44100_128", "pcm_16000"]
      }
    },
    "body": {
      "model_id": "string",
      "voice_settings": "object"
    }
  }
}
```

The MCP spec similarly emphasizes structured content and output schemas for tool results, and that is the right mental model here too: all command outputs should be structured and schema-validatable. ([Model Context Protocol](https://modelcontextprotocol.io/specification/draft/server/tools))

## Risk classifier

Classify each operation from method, path, tags, and operationId.

```ts
function classifyRisk(op: OperationCard): Risk {
  if (op.method === "DELETE") return "destructive";
  if (/delete|disable|remove|revoke/i.test(op.operationId)) return "destructive";
  if (/outbound|call|whatsapp|sms|invite|batch/i.test(op.operationId)) return "external_side_effect";
  if (op.method === "GET") return "read";
  if (/speech|music|sound|generate|compose|isolation|dub|transcribe/i.test(op.operationId)) return "generate";
  return "mutate";
}
```

Risk is included in `ops get`.

## Wait and polling

Some ElevenLabs operations are asynchronous or long-running. Voice design, audio isolation, dubbing, speech-to-text workflows, batch calls, tests, and analysis can take time. The official MCP README even notes that some operations can take long enough to hit inspector timeouts. ([GitHub](https://github.com/elevenlabs/elevenlabs-mcp))

Generic wait:

```bash
elv wait \
  --cmd '["elv","call","get_dubbing","--json","{\"path\":{\"dubbing_id\":\"abc\"}}"]' \
  --status-path '$.data.status' \
  --success 'dubbed,completed,done,succeeded' \
  --failure 'failed,error,cancelled' \
  --interval-ms 2000 \
  --timeout-ms 600000
```

Aliases like `elv dubbing create --wait` can hide that complexity.

## Pagination and token control

Default list behavior:

```text
Return at most 20 items inline.
Include total/count if provider returns it.
Include next cursor/page command if available.
Support --limit N.
Support --all only when --save-json or --out is set.
```

Example:

```json
{
  "ok": true,
  "data": {
    "items": [],
    "count_returned": 20,
    "truncated": true,
    "next": {
      "cmd": "elv call get_speech_history --json '{\"query\":{\"page_size\":20,\"start_after_history_item_id\":\"...\"}}'"
    }
  }
}
```

This is one of the biggest practical wins for token efficiency. Agents usually need the ID and a few fields, not 1000 full objects.

## Agent guidance file

Ship an `AGENTS.md` inside the repo and package. It should be tiny:

```md
# elv agent usage

Use `elv ops search <query>` to find operations.
Use `elv ops schema <operation_id>` before unfamiliar calls.
Use `elv call <operation_id> --json ...` for complete API coverage.
Use aliases like `elv tts`, `elv stt`, `elv music`, and `elv agents` for common workflows.
All commands return exactly one JSON object to stdout.
Generated audio/video/zip/binary outputs are saved to disk and returned in `files[]`.
Do not pass API keys as args. Set `ELEVENLABS_API_KEY`.
For DELETE, outbound calls/messages, API key mutation, and workspace member changes, add `--yes`.
```

## README examples

Include these exact examples.

Discover:

```bash
elv ops search "text to speech"
elv ops schema text_to_speech_full
```

TTS via alias:

```bash
elv tts --voice-id 21m00Tcm4TlvDq8ikWAM --text "Hello from elv." --out ./out
```

TTS via complete operation runner:

```bash
elv call text_to_speech_full \
  --json '{"path":{"voice_id":"21m00Tcm4TlvDq8ikWAM"},"body":{"text":"Hello from elv.","model_id":"eleven_v3"}}' \
  --out ./out
```

Speech-to-text:

```bash
elv stt --file ./meeting.mp3 --model scribe_v2 --out ./out/transcript.json
```

Voice isolation:

```bash
elv voice-isolate --file ./noisy.mp3 --out ./out/clean.mp3
```

Raw endpoint:

```bash
elv http GET /v1/voices
```

Schema update:

```bash
elv spec update
```

Dry run:

```bash
elv call text_to_speech_full --json-file request.json --dry-run
```

## Tests and acceptance criteria

The implementation is done only when these pass:

```text
1. Every command emits exactly one valid JSON object to stdout.
2. No command emits color, spinners, progress bars, or prose by default.
3. Failed commands exit nonzero and still emit a valid ErrorEnvelope.
4. The OpenAPI compiler discovers every operation with an operationId.
5. `elv ops search` can find operations by operationId, path, tag, summary, and description.
6. `elv ops schema <id>` returns compact required and optional inputs.
7. `elv call <id>` can execute JSON requests, multipart requests, query-only requests, and path-param requests.
8. Binary responses are written to files and never printed to stdout.
9. Large JSON responses are truncated inline and saved to disk.
10. ElevenLabs `detail` errors are preserved as structured errors.
11. 429 rate-limit errors trigger exponential backoff when retry is safe.
12. DELETE and external side-effect operations require `--yes`.
13. API keys are never printed in normal output, dry-run output, debug logs, or test snapshots.
14. `elv http` works even for endpoints absent from the registry.
15. `elv ws` can send NDJSON events and save received events.
16. Aliases call the same core runner as `elv call`, with no duplicate HTTP logic.
17. Response parsing ignores unknown response fields.
18. CI runs unit tests without a real ElevenLabs API key.
19. Integration tests are gated behind `ELEVENLABS_API_KEY`.
20. `elv config doctor` gives structured pass/fail diagnostics.
```

## Implementation phases

Phase 1: Core shell contract. Build CLI skeleton, config loader, envelope writer, redaction, and test that stdout is always JSON.

Phase 2: OpenAPI compiler. Fetch and compile the ElevenLabs spec into `OperationCard`s. Implement `ops search`, `ops get`, and `ops schema`.

Phase 3: Generic REST coverage. Implement `call`, JSON requests, path/query/body normalization, response normalization, provider error parsing, retries, and binary output.

Phase 4: Multipart and files. Implement `--file`, arrays of files, deterministic output filenames, manifest generation, hashes, and large JSON spill-to-disk.

Phase 5: Generic escape hatches. Implement `http`, `ws`, and `wait`.

Phase 6: Aliases. Implement only the common thin wrappers: `tts`, `stt`, `music`, `sfx`, `voice-change`, `voice-isolate`, `voices`, `models`, `agents`, `dubbing`, `history`, `usage`.

Phase 7: Harden. Add risk classification, `--yes`, `--dry-run`, integration tests, README examples, and `AGENTS.md`.

## The handoff prompt for the implementation agent

```text
Build a TypeScript/Node 22 CLI named `elv`, an agent-first wrapper around the ElevenLabs API.

Core requirements:
- This is for AI agents, not humans.
- Every command must be non-interactive.
- Every command must print exactly one JSON object to stdout.
- Never print non-JSON text, colors, spinners, banners, or progress bars.
- On failure, print a structured JSON error envelope to stdout and exit nonzero.
- Read the API key from ELEVENLABS_API_KEY. Never print or log it.
- Use xi-api-key authentication.
- Implement an OpenAPI-driven operation runner using the ElevenLabs OpenAPI 3.1 spec.
- Preserve full API coverage by supporting `elv call <operation_id>` for every OpenAPI operation and `elv http <method> <path>` as an escape hatch.
- Add `elv ws` for generic WebSocket sessions.
- Add `elv ops search`, `elv ops get`, and `elv ops schema` for token-efficient discovery.
- Save binary and large outputs to files. Return file paths, MIME type, byte count, and sha256 in the JSON envelope.
- Capture provider headers like character-cost, request-id, and x-trace-id when present.
- Parse ElevenLabs error responses and preserve detail.type, detail.code, detail.message, detail.param, and detail.request_id.
- Implement exponential backoff for safe retries on 429 and transient 5xx.
- Require --yes for destructive operations and external side effects.
- Add thin aliases for tts, stt, music, sfx, voice-change, voice-isolate, voices, models, agents, dubbing, history, and usage. Aliases must call the same core runner as `elv call`.

Architecture:
- src/cli.ts for command routing.
- src/openapi/* for fetching, compiling, compacting, and loading the operation registry.
- src/core/* for client, request builder, response normalizer, envelopes, retries, files, safety, config, and redaction.
- src/commands/* for ops, call, http, ws, wait, config, and aliases.
- tests must verify that stdout is always one JSON object and that no secret is ever leaked.

Do not hand-write hundreds of endpoint-specific commands. The generic OpenAPI operation runner is the completeness layer. Aliases are just ergonomic wrappers.
```

That spec should produce the thing you actually want: tiny surface area, complete API reach, low token load, and no nonsense for agents trying to get work done.