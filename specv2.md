# `elv` — agent-first ElevenLabs CLI — Spec v2

> **Status of this revision.** v2 folds in corrections ground-truthed against the live ElevenLabs OpenAPI document (`https://api.elevenlabs.io/openapi.json`, fetched 2026-06-25: OpenAPI 3.1.0, 320 operations) **plus** three rounds of docs research that validated the off-spec surfaces — the WebSocket/realtime protocol, the error/rate-limit/concurrency model, and the credit/cost + pagination conventions. Every claim is now either confirmed against the live spec or cited to ElevenLabs docs; see the Validation Status table (§24). A short list of low-risk residual unknowns to confirm against live API traffic is noted there too. **Then hardened by a fresh-context adversarial review** that caught (and this revision fixed) two blockers — a budget-guard that silently skipped TTS/SFX/isolation, and a deref-vs-bundle hazard — plus the error/exit-code, dry-run-ordering, streaming, WS-lifecycle, and audio-duration gaps. Section headers note where v2 corrects v1; inline "(per review)" notes mark fixes from that pass.

---

## 0. Thesis (unchanged from v1, still correct)

Build a **small, agent-first CLI runtime over the ElevenLabs OpenAPI spec**, not a hand-written CLI mirroring every endpoint. Three layers:

1. **OpenAPI operation runner** — complete coverage. Compiles every REST operation from the spec into a local registry; validates input, builds the request, normalizes the response, spills binaries/large JSON to disk, returns one JSON envelope.
2. **Generic escape hatches** — `http` (arbitrary REST) and `ws` (scripted WebSocket sessions) so coverage survives spec lag and beta endpoints.
3. **Agent ergonomics layer** — ~12 thin aliases (`tts`, `stt`, `music`, `sfx`, `voice-change`, `voice-isolate`, `voices`, `models`, `agents`, `dubbing`, `history`, `usage`) that build an `AgentInput` and call the *same* core runner. No alias contains its own HTTP logic.

The whole product is an **agent protocol over the shell**: deterministic, non-interactive, quiet, one machine-readable JSON object per command.

### Empirical facts the design now relies on (verified against the live spec)
- **320 operations, every one has a unique `operationId`** (0 missing, 0 duplicates). The registry keys on `operationId` safely; no synthetic-id fallback is needed, but the compiler still asserts uniqueness and fails loudly if a future spec breaks it.
- **Fern vendor extensions are present and usable:** `x-fern-sdk-group-name` (grouping), `x-fern-streaming` (11 ops) and `x-fern-sdk-streaming` (1 op) for streaming detection (note: streaming is chunked bytes or chunked JSON, not SSE — §6).
- **`x-skip-spec: true` exists** (1 op today) — these are internal/hidden and are **excluded** from the registry.
- **Binary is detectable from declared response content types:** `audio/mpeg` (14), `audio/*` (4), `application/zip` (2) **and `application/x-zip`**, plus `text/html`/`text/plain`. Detection keys off the response `Content-Type` at runtime, with the OpenAPI declared content as the fallback signal.
- **27 endpoints declare `multipart/form-data`** request bodies.
- **6 component schemas are genuinely recursive** (`ArrayJsonSchemaProperty`, `ObjectJsonSchemaProperty`, `DynamicVariableNestedValueType`, each in `-Input`/`-Output` flavors). Naive eager `$ref` dereferencing hangs — see §7.
- **Fern emits split `-Input`/`-Output` schemas.** Request validation binds to `-Input`; response shaping reads `-Output`.
- **Documented response headers include** `character-cost`, `song-id`, and `Content-Disposition` (in the OpenAPI). Runtime research confirms ElevenLabs also returns `request-id` and `x-trace-id` on **both success and error** responses, plus `current-concurrent-requests` / `maximum-concurrent-requests` (concurrency headroom). Capture all of these.

---

## 1. Product name & distribution

Binary: `elv`. Package: `@your-org/elv` (or `eleven-agent-cli`). TypeScript on **Node 22+** for `npx` use, native `fetch`, web streams, and single-package publish via `tsup`.

```bash
elv
```

---

## 2. North-star: the four questions

`elv` exists to let an agent cheaply answer:

```text
What can I do?            → elv ops search
What does this op need?   → elv ops schema <id>
Run it.                   → elv call <id> / elv <alias>
Where did output go?      → files[] in the envelope
```

---

## 3. Command surface

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

The power is in `ops`, `call`, `http`, `ws`. Aliases are sugar.

**`ops search` ranking (specified per review m5):** over the 320 ops, results are deterministically ranked — exact `operationId`/path match > field-weighted token overlap (operationId & path weighted above summary & description) > tag/group match — with a stable tie-break on `operationId` and a default `--limit 10`. A query like `"text to speech"` must surface `text_to_speech_full` in the top results.

---

## 4. Output contract

Every command emits **exactly one JSON envelope to stdout** — including failures, which still print a valid `ErrorEnvelope` and exit nonzero. Streaming and WebSocket commands write bytes to files and still emit exactly one *terminal* envelope to stdout; they never stream partial JSON to stdout. Progress, if ever, goes to **stderr** and only under `ELV_DEBUG`.

Every envelope carries a schema version (`"v"`) so wrappers can detect format drift.

### Success
```json
{
  "v": 1,
  "ok": true,
  "cmd": "elv tts",
  "operation_id": "text_to_speech_full",
  "http": { "status": 200, "method": "POST", "path": "/v1/text-to-speech/{voice_id}" },
  "request": { "id": "request-id-if-present", "trace_id": "x-trace-id-if-present", "song_id": null },
  "concurrency": { "current": 2, "max": 10 },
  "cost": { "credits_estimated": 123, "credits_charged": null, "credits_source": "estimate" },
  "data": { "voice_id": "21m00Tcm4TlvDq8ikWAM", "model_id": "eleven_v3" },
  "files": [
    { "path": "/abs/out/speech.mp3", "mime": "audio/mpeg", "bytes": 481293, "sha256": "…" }
  ],
  "truncated": false,
  "warnings": [ { "code": "cost_header_absent", "message": "TTS does not return a cost header; credits_charged is estimate-only." } ],
  "hints": []
}
```

**Cost reconciliation is endpoint-dependent (corrected per review).** The `character-cost` response header is declared in the OpenAPI **only on `/v1/sound-generation`** (`song-id` on `/v1/music*`). TTS returns no cost header. So `credits_charged` is populated only when the provider actually returns a cost header; otherwise it is `null`, `credits_source` is `"estimate"`, and a `cost_header_absent` warning is emitted. Never fabricate a charged value. Whether more endpoints emit `character-cost` at runtime is in the residual-unknowns list (§24) — verify before claiming reconciliation broadly.

### Failure
```json
{
  "v": 1,
  "ok": false,
  "cmd": "elv call text_to_speech_full",
  "operation_id": "text_to_speech_full",
  "http": { "status": 422, "method": "POST", "path": "/v1/text-to-speech/{voice_id}" },
  "error": {
    "type": "validation_error",
    "code": "invalid_parameters",
    "message": "model_id: value is not a valid enumeration member",
    "param": "model_id",
    "request_id": "provider-request-id-if-present",
    "raw": { "detail": [ { "loc": ["body","model_id"], "msg": "…", "type": "…" } ] }
  },
  "retry": { "recommended": false, "after_ms": null },
  "hints": [ { "cmd": "elv ops schema text_to_speech_full", "why": "Inspect required params and accepted enum values." } ]
}
```

### Error normalization (corrected in v2, validated by research)
ElevenLabs is mid-migration between an old and new error model, so the normalizer must handle **four** `detail` variants. **Disambiguate by the runtime type of `detail`:**

1. **FastAPI validation — `detail` is an ARRAY (HTTP 422):** `{ "detail": [ { "loc": ["body","model_id"], "msg": "…", "type": "…" } ] }`. Derive `error.param` from the last meaningful element of `loc`; prefix the message with `loc[0]` (`body`/`query`/`path`). `error.message` = `msg`; `error.code` = `"validation_error"`.
2. **Current structured object — `detail` is an OBJECT with `code`:** `{ "detail": { "type": "validation_error", "code": "invalid_parameters", "message": "…", "status": "invalid_parameters", "request_id": "…", "param": "keyterms" } }`. This is the canonical model. `status` is a **legacy alias for `code`** ("no longer used"). Note: app-level `validation_error` here is **HTTP 400**, distinct from the framework's 422.
3. **Legacy object — `detail` is an OBJECT with only `{status, message}`:** `{ "detail": { "status": "invalid_api_key", "message": "Invalid API key" } }`. Still emitted by many endpoints.
4. **Bare string — `detail` is a STRING:** rare; preserve verbatim.

**Field-mapping rule (covers all four):**
```text
error.code       = detail.code ?? detail.status ?? "<generic from http status>"
error.type       = detail.type ?? classifyFromStatusCode(http.status)
error.message    = detail.msg (array) ?? detail.message ?? (string)detail ?? "<status text>"
error.param      = detail.param ?? deriveFromLoc(detail[0].loc) ?? null
error.request_id = detail.request_id ?? response.headers["request-id"] ?? null
error.raw        = <full provider body, always>
```

**Known machine-readable codes an agent branches on** (from research; `status` legacy aliases in parens):
```text
TERMINAL (never retry, surface to user):
  invalid_api_key / missing_api_key (401)        detected_unusual_activity (401, free-tier abuse)
  insufficient_credits / quota_exceeded (402/401) forbidden / insufficient_permissions /
  voice_not_found (404)                            feature_not_available (403)
  invalid_parameters / text_too_long /
    max_character_limit_exceeded (400)
RETRYABLE:
  rate_limit_exceeded (429)          → exponential backoff + jitter
  system_busy (429)                  → exponential backoff + jitter
  concurrent_limit_exceeded (429, legacy too_many_concurrent_requests)
                                     → THROTTLE own concurrency, wait for in-flight to drain; do NOT escalate backoff
  internal_error (500) / service_unavailable (503) → exponential backoff
  concurrent_modification (409)      → TERMINAL-but-informative; no auto-retry. Hint: re-fetch + re-issue
```

The full provider body is always preserved under `error.raw`. **We are lenient on responses and strict on requests** (per ElevenLabs' breaking-change policy: additive response fields are non-breaking and clients must ignore unknown fields).

### Exit-code taxonomy (new in v2; redesigned per review)
Agents branch on exit code without parsing JSON. Codes key on the **body `code`**, not raw HTTP status, so the 400-vs-422 split and the 401-vs-402 quota split don't leak through:

```text
0  success
2  input/validation   — body code invalid_parameters/validation_error/text_too_long/
                         max_character_limit_exceeded, OR our own pre-flight validator (covers 400 AND 422)
3  auth/permission    — invalid_api_key/missing_api_key/forbidden/insufficient_permissions/
                         feature_not_available/detected_unusual_activity
4  confirmation required — --yes missing on a destructive/external_side_effect op
5  budget ceiling     — our --max-credits pre-flight blocked the call (no network)
6  credit/quota exhausted — provider insufficient_credits/quota_exceeded (regardless of 401 vs 402);
                         distinct from 5 so an agent knows "out of money" vs "I set a cap"
7  transient/retryable exhausted — 429 (rate-limit/concurrency) + 5xx after retries, network failure
8  provider error     — other 4xx/5xx not covered above
9  not-found          — 404, unknown operation_id
```

Codes 4 (raise `--max-credits` or accept), 5 (raise the cap), and 6 (top up credits) are deliberately distinct because each needs a different remediation.

---

## 5. Input model

Canonical input to `elv call` is explicit JSON with `path`/`query`/`body`/`headers` buckets:

```bash
elv call text_to_speech_full \
  --json '{"path":{"voice_id":"21m00Tcm4TlvDq8ikWAM"},"query":{"output_format":"mp3_44100_128"},"body":{"text":"Hello.","model_id":"eleven_v3"}}' \
  --out ./out
```

**Flat JSON** is also accepted and resolved against the operation's compiled params. Placement is determined **purely by match-count** — there is no precedence ordering (per review: precedence and the ambiguity rule contradict each other, so precedence is removed):

```text
key matches exactly 1 declared location  → route there
key matches 0 declared params            → reject (exit 2), or route to body if --allow-unknown
key matches 2+ locations                 → AMBIGUOUS → hard error (exit 2), print the explicit
                                           bucketed shape; never silently routed
```

Input forms:
```bash
--json '{"body":{"text":"hi"}}'
--json-file request.json
--stdin-json
--query key=value
--path key=value
--file field=/path/to/file.mp3
--file 'samples[]=/path/a.wav'
--file 'samples[]=/path/b.wav'
```

The CLI owns multipart boundary construction. Agents never build multipart by hand.

---

## 6. Binary, streaming & large-response handling

Default: **never** emit binary or base64 to stdout.

```text
JSON < 32 KB            → inline in data.
JSON ≥ 32 KB            → data_summary inline + full JSON saved to file.
Binary                  → save to file, files[] only.
streamKind audio_bytes  → pipe raw bytes to audio.<ext>; emit terminal envelope.
streamKind json_events  → PARSE each chunk as JSON; write events to .ndjson; extract+base64-decode any
                          audio field to audio.<ext>; emit terminal envelope. (e.g. *_with_timestamps streams)
streamKind text         → write to .txt/.html.
Zip                     → save zip; do not unpack unless --unpack.
```

**Streaming is three different things, not one (corrected per review).** ElevenLabs has **no `text/event-stream`** anywhere — "SSE" was wrong. The 11 streaming ops split by declared 200 content type: most are `audio/mpeg` raw chunked bytes (`audio_bytes`), but `text_to_speech_stream_with_timestamps` and `text_to_dialogue_stream_with_timestamps` are `application/json` carrying base64 audio + alignment that must be **parsed, not piped** (`json_events`) — piping them produces a corrupt `.mp3`. The runner branches on `op.streamKind`.

**Implementation notes (Node 22, corrected in v2):**
- Detect binary from the runtime `Content-Type` first, declared OpenAPI content second, `mime-types` only for choosing a file extension. Treat `application/zip`, `application/x-zip`, and `application/octet-stream` (and any `application/*zip*`) as binary.
- Stream `audio_bytes`/binary response bodies to disk with `Readable.fromWeb(res.body).pipe(...)`. **Never** `await res.arrayBuffer()` on a binary/streamed response — it buffers the whole payload into memory.
- **Multipart uploads must stream from the start on the known-hot path.** `dubbing create` uploads video that routinely exceeds tens of MB; native `FormData`/`Blob` buffers the whole file and will OOM. Use a streaming multipart body (`form-data` streamed part / undici) for file uploads; do **not** defer this — it's guaranteed needed by a first-class alias. Reject uploads above a hard cap with a clear error rather than OOMing.
- **Filenames (deterministic, single source):** derive from inputs — `{alias-or-operationId}[-{discriminator}].{ext}` (discriminator = e.g. target language for dubbing). This is reproducible across machines. Fall back to the server's `Content-Disposition` filename **only** when no deterministic name is derivable, and note it in the file record. On an existing-name collision with *different* content, append a short content-hash; identical re-runs overwrite.
- **`--out file` (single path) is valid only for single-file ops.** Ops that emit multiple files (dubbing per-language; audio + timestamps JSON) require a directory; using `--out file` errors with a hint to pass a directory.
- **Hashing:** sha256 every file, but `ponytail: skip hashing files over a configurable cap (default 64MB) unless --hash is set` — don't hash hundreds of MB of dubbing video on every call.

Large-JSON envelope:
```json
{
  "v": 1, "ok": true,
  "data_summary": { "type": "array", "count": 1000, "preview_count": 20, "preview": [] },
  "files": [ { "path": "/abs/out/full-response.json", "mime": "application/json", "bytes": 920312 } ],
  "truncated": true,
  "hints": [ { "cmd": "elv view /abs/out/full-response.json --jq '.items[0]'", "why": "Inspect without loading into context." } ]
}
```

---

## 7. OpenAPI compiler

Source: `https://api.elevenlabs.io/openapi.json` (OpenAPI 3.1.0). A **vendored snapshot ships in the package** (`spec/openapi.snapshot.json`) so a cold `npx elv` with an empty cache always has a registry to compile from; `spec update` overlays a fresher spec into the cache.

```ts
type OperationCard = {
  operationId: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  pathTemplate: string;
  group: string[];          // from x-fern-sdk-group-name → tags → path
  summary?: string;
  description?: string;
  tags: string[];
  risk: "read" | "generate" | "mutate" | "destructive" | "external_side_effect";
  pathParams: ParamCard[];
  queryParams: ParamCard[];
  headerParams: ParamCard[];
  requestBody?: BodyCard;    // bound to the -Input schema
  responses: ResponseCard[];
  returnsBinary: boolean;
  returnsJson: boolean;
  streamKind: "none" | "audio_bytes" | "json_events" | "text";  // see §6
  costHint?: "characters" | "audio_seconds" | "per_generation" | "per_source_minute" | "slot" | "unknown";
  deprecated: boolean;
  examples: ExampleCard[];
};
```

Compile steps:
```text
1.  Load spec (cache → vendored snapshot fallback).
2.  BUNDLE, do not dereference. Resolve only EXTERNAL $refs; KEEP internal $ref pointers intact
    (@apidevtools/json-schema-ref-parser .bundle(), not .dereference()). Full dereferencing would
    expand the 6 recursive schemas into cyclic JS object graphs that (a) JSON.stringify cannot
    serialize for the cache (step 14) and (b) Ajv does not want anyway. Bundling stays cycle-safe
    for free and is the correct input for both Ajv ($ref + registered components) and the cache.
3.  Extract each path + method. Skip operations with x-skip-spec: true.
4.  Preserve operationId exactly; assert global uniqueness (fail compile on dup).
5.  Derive group from x-fern-sdk-group-name → tags → path segment.
6.  Extract path/query/header params (use the -Input side for request schemas).
7.  Extract request body content types; flag the 27 multipart ops.
8.  Detect multipart fields and which are file/binary parts.
9.  Detect binary responses from response Content-Type + schema format: binary.
10. Classify response stream shape into streamKind (see §6) from x-fern-streaming + the declared
    200 Content-Type: audio/* → audio_bytes; application/json → json_events; text/* → text.
11. Generate compact agent-facing schemas (see §12) from the -Input schema. The generator MUST be
    cycle-aware: carry a visited-set and render a recursive node as {"$recursive":"<SchemaName>"}
    (or depth-cap) rather than expanding it — same hazard the bundler avoids.
12. Classify risk (see §13).
13. Assign costHint per operation from a CURATED operationId→costHint map (not substring/group
    inference): characters / audio_seconds / per_generation / per_source_minute / slot / unknown.
    This map is also what the budget guard keys on (§14) — decoupled from the risk label.
14. Write registry to ~/.cache/elv/<elv-version>/openapi.compact.json (version-stamped; internal
    $refs preserved, so it serializes cleanly).
15. Save the raw spec for --raw / debugging.
```

**Cache versioning:** the compact registry is stored under the `elv` binary version. On version mismatch the registry is recompiled automatically, so an old cache never breaks a new binary. `elv spec update` runs weekly-cadence-friendly (ElevenLabs publishes API updates weekly).

**Ajv config:** validate with `Ajv2020` (`ajv/dist/2020`) — the spec is JSON Schema 2020-12, not draft-07 (draft-07 mis-handles `const`, `prefixItems`, type-array nullability). Register all component schemas with `addSchema` and validate request bodies by `$ref` (matches the bundle step). Run with `strict: false` and `ajv-formats` installed; OpenAPI-only keywords (`example`, `discriminator`, `xml`, `externalDocs`, `x-*`) must be ignored/stripped or Ajv strict-mode throws on the raw schemas.

---

## 8. Request runner

```ts
async function runOperation(operationId: string, input: AgentInput, opts: RunOpts): Promise<Envelope> {
  const op = (await loadRegistry()).get(operationId);
  if (!op) return errUnknownOperation(operationId);          // exit 7

  const normalized = normalizeInput(op, input);              // flat→bucketed, ambiguity check
  const validation = validateInput(op, normalized);          // Ajv2020 on -Input schema
  if (!validation.ok) return errValidation(validation);      // exit 2

  const estimate = estimateCredits(op, normalized, opts);    // null when not estimable

  // dry-run previews BEFORE the gates so an agent can inspect a destructive/expensive call.
  if (opts.dryRun) {
    return dryRunEnvelope(op, normalized, {                  // redacted, no network
      credits_estimated: estimate,
      would_require_yes: requiresYes(op),                    // informational, does not block
      would_exceed_budget: overBudget(estimate, opts),       // informational, does not block
    });
  }

  enforceSafety(op, opts);                                   // --yes gate (exit 4)
  enforceBudget(estimate, opts);                             // --max-credits preflight (exit 5)

  const req = buildHttpRequest(op, normalized);
  const res = await sendWithRetry(req, op);
  return normalizeResponse(op, res);                         // captures cost headers, charged credits
}
```

**Dry-run ordering (fixed per review):** dry-run returns **after validation but before** the `--yes` and budget gates, so `--dry-run` on a destructive op (without `--yes`) or an over-budget op still previews the request instead of exiting 4/5. The would-block verdicts are reported as informational fields inside the dry-run envelope.

### Retry policy (validated by research)
```text
Retryable HTTP: 429 (branch on body code — see below), 500, 502, 503, 504.
Never retry:    400, 401, 402, 403, 404, 409, 422  (deterministic client errors).
                detected_unusual_activity (401) and insufficient_credits/quota_exceeded are TERMINAL.
                409 concurrent_modification is TERMINAL-BUT-INFORMATIVE: do not auto-retry (the generic
                runner has no resource-graph knowledge to re-fetch + merge a version field). Return
                retry.recommended:false with a hint to re-fetch the resource and re-issue manually.

429 branches on the body code:
  rate_limit_exceeded / system_busy        → exponential backoff + jitter.
  concurrent_limit_exceeded (legacy
    too_many_concurrent_requests)          → DO NOT escalate backoff. Throttle our own concurrency
                                             and wait for in-flight requests to drain.

Retry-After: ElevenLabs does NOT document a Retry-After header (research: open question, likely absent).
  Honor it if present; otherwise use client-side exponential backoff.
Concurrency headroom: read current-concurrent-requests / maximum-concurrent-requests from responses.
  NOTE: a request semaphore only bounds concurrency WITHIN one elv invocation's own fan-out
  (--all, wait, multi-file). Separate elv processes are NOT coordinated — the real cross-process
  safety net is the 429 concurrency-throttle path above. Do not claim the semaphore enforces the
  plan limit globally (limits vary by plan AND endpoint family).

POST retries and the double-charge hazard (NEW constraint):
  ElevenLabs has NO idempotency mechanism (no Idempotency-Key). Retrying a generate POST can double-charge
  credits. Therefore: GET/HEAD retry freely; POST is NOT auto-retried by default. --retry-post opts in, and
  the budget guard (§14) accounts for the retry multiplier when --retry-post is set.
```

---

## 9. Generic HTTP escape hatch

```bash
elv http GET /v1/voices
elv http POST /v1/text-to-speech/21m00Tcm4TlvDq8ikWAM \
  --query output_format=mp3_44100_128 --body-json '{"text":"Hi","model_id":"eleven_v3"}' --out ./out
elv http POST /v1/audio-isolation --file audio=/tmp/noisy.mp3 --out ./out
```

Uses the same auth, envelope, retries, binary handling, redaction, and error normalization as `call`.

---

## 10. WebSocket primitive (reframed in v2)

**Reality check:** WebSocket endpoints are **not in the OpenAPI document** (OpenAPI 3.x can't describe them), so `ops search` cannot discover them. v2 ships a **hardcoded WS catalog** (validated against ElevenLabs' AsyncAPI docs), addressable by name:

| Catalog name | WSS URL template | Scriptable? |
|---|---|---|
| `tts-realtime` | `wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input?model_id=…` | ✅ yes |
| `tts-multi` | `wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/multi-stream-input?model_id=…` | ✅ yes (≤5 contexts) |
| `stt-realtime` | `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime` | ✅ yes |
| `convai` | `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=…` | ⚠️ interactive only |

```bash
elv ws tts-realtime --query voice_id=… --query model_id=eleven_flash_v2_5 --send script.ndjson --out ./out/session
elv ws tts-multi    --query voice_id=… --send script.ndjson --out ./out/session
elv ws stt-realtime --send audio-chunks.ndjson --out ./out/session
elv ws <raw-path-or-wss-url> --send events.ndjson --out ./out/session     # escape hatch
elv ws --list                                                            # prints catalog + required params + auth
```

**Validated WS facts (fold into the catalog + session player):**
- **Auth (priority order):** `xi-api-key` header on the upgrade request → `single_use_token` query param (client-safe, minted via the create-token endpoint) → `xi_api_key` field inside the first message. **ConvAI** uses a **signed URL** from `GET /v1/convai/conversation/get-signed-url` (expires 15 min) for private agents, or a bare `agent_id` for public ones.
- **Audio is base64 text, not binary frames.** Each server message carries `{"audio": "<base64>"}`; the session writer base64-decodes and concatenates in order. Default `output_format=mp3_44100`; PCM/µ-law/Opus selectable. STT realtime is the reverse: the client sends base64 `input_audio_chunk` (PCM 16-bit mono, 16 kHz, ~32 KB ≈ 1 s).
- **TTS-over-WS does NOT support `eleven_v3`.** Use `eleven_flash_v2_5` (lowest latency). The catalog default reflects this; `eleven_v3` over a WS catalog entry is rejected with a clear error.
- **Protocol gotchas baked into the player:** first message must be `{"text":" "}` (single space); `{"text":""}` **closes** the socket (and force-generates buffered text) while `{"text":" "}` is the **keep-alive**; `voice_settings`/`generation_config`/pronunciation dictionaries are honored **only in the first message**; 20 s inactivity timeout (multi-context raisable to 180 s, ≤5 contexts). Multi-context adds `context_id` to every message and `{"close_context":true}` / `{"close_socket":true}`.
- **Auto-pong:** any catalog endpoint using ping/pong (ConvAI) needs a built-in pong responder echoing `event_id`. The scripted player handles ping→pong automatically; it is not part of the send-script.
- **Regional hosts:** `api.us` / `api.eu.residency` / `api.in.residency` / `api.sg.residency` on the same paths (driven by `--base-url` / residency config).

**This is a *scripted* (batch) WS primitive** for `tts-realtime`, `tts-multi`, and `stt-realtime`: it plays a fixed NDJSON send-script (plus auto-pong) and records everything received. It does **not** do barge-in or receive-conditioned sends. **ConvAI is genuinely interactive** (server-driven turn-taking, ping/pong, `user_activity` keepalive every 30–60 s) and is therefore **out of scope for the generic scripted primitive** — it's a future dedicated `agents converse` alias or an SDK job, not `elv ws convai --send`.

Send-script (NDJSON). **The script author owns the full first message** (the mandatory `{"text":" "}` keep-alive plus any `voice_settings`/`generation_config`/pronunciation, which are honored only there). The player does not synthesize it — it cannot know the author's `voice_settings`:
```json
{"type":"send","data":{"text":" ","voice_settings":{"stability":0.5,"similarity_boost":0.8}}}
{"type":"send","data":{"text":"Hello "}}
{"type":"send","data":{"text":"world."}}
{"type":"send","data":{"text":""}}
{"type":"close"}
```

**Session lifecycle (defined per review M8) — the recording continues until the FIRST of:**
```text
(a) server-initiated socket close, OR
(b) inactivity timeout reached (20s default; multi-context raisable to 180s), OR
(c) the script's {"type":"close"} is sent — then DRAIN until the server closes (TTS keeps
    streaming buffered audio after {"text":""}; stopping at script-end truncates the audio).
```
The player validates the script before connecting: the first `send` must be a non-empty-`text` keep-alive, and the requested `model_id` must not be `eleven_v3` (rejected with a clear error — not supported over WS). It auto-responds to any `ping` with `pong` (echoing `event_id`); auto-pong is not part of the script.

Outputs under the session dir: `events.received.ndjson` (raw received JSON), `audio.mp3`/`audio.pcm` (base64 chunks decoded and concatenated), `manifest.json`.

**Auth leak guard (new in v2):** WS auth may place the key in the URL query string (`single_use_token`/`authorization`), in a header, or in a signed-URL token. The session writer redacts `xi-api-key`, `single_use_token`, and any signed token from `manifest.json`, `events.received.ndjson`, and all debug output. The raw connection URL is never persisted with credentials intact.

Envelope:
```json
{
  "v": 1, "ok": true, "cmd": "elv ws",
  "ws": { "catalog": "tts-realtime", "path": "/v1/text-to-speech/{voice_id}/stream-input",
          "events_sent": 4, "events_received": 19, "closed": true },
  "files": [
    { "path": "/abs/session/events.received.ndjson", "mime": "application/x-ndjson" },
    { "path": "/abs/session/audio.mp3", "mime": "audio/mpeg" }
  ]
}
```

---

## 11. Curated aliases

Thin wrappers that build an `AgentInput` and call the core runner. **Never a second HTTP implementation.** An acceptance test asserts each alias produces a **semantically identical normalized request** to the equivalent `elv call` — same method, resolved path, query map, header set (excluding the random multipart boundary), and deep-equal parsed body (JSON object or multipart field-map). The comparison is on the `request-builder` output object, not raw bytes (multipart boundaries and JSON key order make raw bytes differ even when requests are equivalent).

### `elv tts`
```bash
elv tts --voice-id 21m00Tcm4TlvDq8ikWAM --text "Hello." --model eleven_v3 --format mp3_44100_128 --out ./out
elv tts --voice "Rachel" --text-file script.txt --out speech.mp3
elv tts --timestamps --voice-id … --text-file script.txt --out ./out
elv tts stream --voice-id … --text-file script.txt --out ./out
```
Resolution: `--voice-id` used directly; `--voice` resolves via voices search (exact match or fail with candidates); `--model` defaults from config; `--out` dir → deterministic filename.

### `elv stt`
```bash
elv stt --file audio.mp3 --model scribe_v2 --out transcript.json
# --timestamps none|word|character  --diarize  --language <code>  --webhook <url>  --wait
```

### `elv music` / `elv sfx`
```bash
elv music --prompt "30s lo-fi loop, warm, no vocals" --out ./out
elv music stream --prompt-file prompt.txt --out ./out
elv sfx --prompt "Wooden door creaks then soft slam" --duration 3 --out ./out
```

### `elv voice-change` / `elv voice-isolate`
```bash
elv voice-change --voice-id … --file input.wav --out ./out
elv voice-isolate --file noisy.mp3 --out clean.mp3
```

### `elv dubbing`
```bash
elv dubbing create --file video.mp4 --source en --target es --wait --out ./out
elv dubbing get --id <dubbing_id>
elv dubbing audio --id <dubbing_id> --language es --out ./out
```

### `elv voices` / `elv agents` / `elv history` / `elv usage`
```bash
elv voices list --limit 20
elv voices find "Juniper"
elv voices get --voice-id …
elv voices clone-instant --name "…" --file sample.wav

elv agents list
elv agents get --agent-id …
elv agents create --json-file agent.json
elv agents update --agent-id … --json-file patch.json
elv agents simulate --agent-id … --text "…"

elv models list                       # GET /v1/models — id, name, languages, cost factor

elv history list --limit 20
elv history audio --id <history_item_id> --out ./out
elv history delete --id <history_item_id> --yes

elv usage                              # GET /v1/user/subscription → remaining credits / quota
elv usage --from 2026-06-01 --to 2026-06-25   # GET /v1/usage/character-stats
```

`usage` (no args) reads `GET /v1/user/subscription`. The date-range form reads `GET /v1/usage/character-stats` — **gotcha: `start_unix`/`end_unix` are in MILLISECONDS** on this endpoint (the rest of the API uses seconds), so the alias converts dates to ms. It accepts `--breakdown <voice|model|api_keys|product_type|…>` and `--metric <credits|tts_characters|minutes_used|request_count|…>`.

The ElevenAgents surface is huge (CRUD, versioning/deployments, simulations, conversation search/analysis, tools, knowledge base, tests, phone numbers, widget, secrets, telephony, WhatsApp, batch calling, LLMs, MCP servers, analytics, env vars). The `agents` alias stays **shallow**; the long tail rides on `elv call`.

---

## 12. Compact schema (`ops schema`)

Agents get a compact, validatable schema by default; `--raw` returns the OpenAPI fragment. Generated from the **`-Input`** schema.

```json
{
  "required": { "path": { "voice_id": "string" }, "body": { "text": "string" } },
  "optional": {
    "query": { "output_format": { "type": "string", "enum": ["mp3_44100_128","pcm_16000"] } },
    "body": { "model_id": "string", "voice_settings": "object", "seed": "integer" }
  }
}
```

`ops schema --example` emits a ready-to-run `elv call` line with a filled skeleton from required params — high-leverage for agents:
```json
{ "ok": true, "example": { "cmd": "elv call <id> --json '{\"path\":{\"voice_id\":\"<voice_id>\"},\"body\":{\"text\":\"<text>\"}}' --out ./out" } }
```

---

## 13. Risk classifier (ordering bug fixed in v2; generate-label rebuilt per review)

The v1 classifier checked `external_side_effect` substrings **before** method, so reads like `get_phone_call` / `list_batch_calls` got gated behind `--yes`. v2 fixes the ordering and uses curated allowlists.

**Critical correction (review B1):** the `generate` label must NOT be inferred from an anchored regex over the group name. Verified against the live spec, the real `x-fern-sdk-group-name` values are `text_to_speech`, `text_to_sound_effects`, `audio_isolation`, `text_to_voice` — **none** start with `speech`/`sound`/`isolation`/`voice_design`, so the old `^`-anchored regex classified TTS, SFX, and isolation as `mutate` and the budget guard would have silently skipped the #1 credit-burning op. The fix is twofold: a curated `GENERATE_OP_IDS` set, **and** decoupling the budget guard from this label entirely — see §14.

```ts
function classifyRisk(op: OperationCard): Risk {
  if (op.method === "GET" || op.method === "HEAD") return "read";   // reads are NEVER gated
  if (op.method === "DELETE") return "destructive";
  if (DESTRUCTIVE_OP_IDS.has(op.operationId)) return "destructive";
  if (EXTERNAL_SIDE_EFFECT_OP_IDS.has(op.operationId)) return "external_side_effect"; // outbound calls,
                                                                  // WhatsApp/SMS, batch calling, member invites
  if (GENERATE_OP_IDS.has(op.operationId)) return "generate";     // curated: tts/sfx/music/stt/
                                                                  // voice-change/isolation/dubbing/voice-design
  return "mutate";
}
```

All three sets (`DESTRUCTIVE_OP_IDS`, `EXTERNAL_SIDE_EFFECT_OP_IDS`, `GENERATE_OP_IDS`) are curated once from the 320-op set and reviewed, not inferred from substrings at runtime. Risk is surfaced in `ops get`. An acceptance test asserts `text_to_speech_full`, `sound_generation`, and `audio_isolation` classify as `generate`.

---

## 14. Safety model

**No interactive prompts, ever.** Confirmation is via flags.

```text
DELETE ops require --yes.
external_side_effect ops require --yes (outbound calls, WhatsApp/SMS, batch calls, member removal,
  API-key deletion/disable).
--dry-run on every command prints the (redacted) request envelope without network execution.
```

### Spend safety (new in v2 — the gap v1 missed)
The real agent-loop hazard is **burning credits**, not deleting data. v2 adds a first-class budget guard:

```text
--max-credits N   Pre-flight upper-bound estimate of the op's credit cost; if it exceeds N, fail with
                  exit 5 (budget_exceeded) BEFORE the network call.
ELV_MAX_CREDITS   Session/default ceiling (env or config).
TARGETING:        the guard fires on every op whose registry costHint is a credit-consuming kind
                  (characters/audio_seconds/per_generation/per_source_minute) — NOT on the risk
                  "generate" label (review B1: the two were coupled and the label mis-classified TTS).
Reconciliation:   the envelope reports cost.credits_estimated (pre) and cost.credits_charged (post,
                  only when the provider returns a cost header — §4; else null + estimate-only warning).
```

**Per-modality estimation (validated; no server-side estimate endpoint exists — all client-side). The guard always compares the UPPER BOUND against the ceiling:**
```text
tts            chars × model_ratio × voice_multiplier.
               ratio: multilingual_v2/v3 = 1.0; flash_*/turbo_* documented as a 0.5–1 RANGE by plan.
               For the guard, use the conservative ratio = 1.0 (review m9: 0.5 can under-protect 2×).
               Voice-Library SHARED voices carry an undisclosed multiplier → estimate is a LOWER BOUND;
               warn, and treat shared-voice TTS as requiring --yes.
sfx            duration_seconds set → 11 × duration_seconds.  auto duration → assume 100 (flat).
stt            ~330 credits / audio-minute  (needs input duration — see note).
voice-change   ~1000 credits / audio-minute (needs input duration).
voice-isolate  ~1000 credits / audio-minute (needs input duration).
music          ~900 credits / generated-minute, 5-min cap.  Generated length unknown pre-call →
               use the 5-min cap as the upper bound and warn.
dubbing        ~2000–10000 credits / SOURCE-minute (tier/watermark) × target-language count (needs duration).
voice-design / cloning   slot-based (voice_limit / voice_add_edit_counter), not per-call credits → no estimate.
```

**Getting audio duration (review M4):** stt/voice-change/voice-isolate/dubbing estimates need the duration of a local `mp3`/`wav`/`mp4`. WAV is header math, but MP3/MP4 need real parsing. v2 adds **`music-metadata`** (pure-JS, handles mp3/mp4/wav) to deps for this. When duration still can't be read, the estimate degrades to "unknown" with a `warnings[]` note and the guard compares against the modality's max-duration cap (the upper bound), consistent with how `music` is handled.
Where an estimate is a lower bound or coarse, the envelope `warnings[]` says so. Because there is no idempotency, when `--retry-post` is set the guard multiplies the estimate by the max retry count.

The budget guard (keyed on `costHint`) and the `--yes` gate (keyed on risk class) are **independent**: the guard caps *spend* on generate ops; `--yes` confirms *destructive/external* ops. An op can trip both, neither, or one.

Confirmation-required failure:
```json
{ "v": 1, "ok": false,
  "error": { "type": "confirmation_required", "code": "destructive_operation_requires_yes",
             "message": "Classified destructive. Re-run with --yes." },
  "hints": [ { "cmd": "elv call delete_agent --json-file request.json --yes" } ] }
```

Budget-exceeded failure:
```json
{ "v": 1, "ok": false,
  "error": { "type": "budget_exceeded", "code": "max_credits_exceeded",
             "message": "Estimated 4200 credits exceeds --max-credits 1000." },
  "cost": { "credits_estimated": 4200 },
  "hints": [ { "cmd": "… --max-credits 5000", "why": "Raise the ceiling if intended." } ] }
```

### Security defaults
```text
API key read only from ELEVENLABS_API_KEY or a configured secret provider. Never a positional arg.
Auth header: xi-api-key. Never printed/logged.
Single redaction chokepoint: ALL stdout/stderr (incl. dry-run and ELV_DEBUG) passes through redact()
  which strips xi-api-key, single_use_token, Authorization, cookies, webhook secrets, signed WS tokens.
--base-url for private deployments / data residency.
Profiles supported; raw keys not stored in config unless using OS keychain.
Service-account keys per environment, least privilege (ElevenLabs security guidance).
```

**Dry-run body-leak caveat (review m10):** redaction is key-*name* based, but secret-creating ops (workspace/convai secret-create) carry the secret *value* under an arbitrary body field, which `--dry-run` would echo. Mitigation: mark secret-bearing fields of those ops in the registry for value-redaction, and additionally redact values matching known token shapes. Until that's in place, the AGENTS.md note warns against dry-running secret-create ops with real values.

---

## 15. Config

Env vars:
```bash
ELEVENLABS_API_KEY  ELEVENLABS_BASE_URL  ELEVENLABS_API_RESIDENCY
ELV_PROFILE  ELV_OUTPUT_DIR  ELV_CACHE_DIR  ELV_SPEC_URL
ELV_NO_NETWORK_SPEC_UPDATE  ELV_MAX_CREDITS  ELV_DEBUG
```

Config file:
```json
{
  "default_profile": "prod",
  "profiles": {
    "prod": { "base_url": "https://api.elevenlabs.io", "api_key_env": "ELEVENLABS_API_KEY",
              "output_dir": "./.elv/out", "default_model_id": "eleven_v3", "max_credits": 5000 },
    "test": { "base_url": "https://api.elevenlabs.io", "api_key_env": "ELEVENLABS_TEST_API_KEY",
              "output_dir": "./.elv/test-out" }
  }
}
```

`elv config doctor` verifies: API key present; base URL reachable; registry exists; spec age; output dir writable; Node version supported; and remaining-credit balance via `GET /v1/user/subscription` when reachable (`character_count` / `character_limit` / `next_character_count_reset_unix`).

---

## 16. `wait` (ergonomics fixed in v2)

v1's `wait` re-exec'd `elv` per poll via a JSON-encoded argv array — an escaping nightmare and ~100–300ms Node cold-start per interval. v2's primary form is **in-process**:

```bash
elv wait --operation get_dubbing \
  --json '{"path":{"dubbing_id":"abc"}}' \
  --status-path '$.data.status' \
  --success 'dubbed,completed,done,succeeded' \
  --failure 'failed,error,cancelled' \
  --interval-ms 2000 --timeout-ms 600000
```

It calls the operation in-process each interval, reads `--status-path` from the envelope, and resolves on success/failure values. `--cmd '["elv",...]'` remains as an escape hatch for chaining arbitrary commands. Aliases like `dubbing create --wait` wrap this.

**`--status-path` is a dotted path, not full JSONPath (decided per review m3):** dotted keys + numeric indices (`data.status`, `data.items.0.state`); a leading `$.` is tolerated. Filter/wildcard/recursive-descent syntax is rejected with a clear error rather than silently no-matching — avoids pulling in a JSONPath dependency for a feature that only ever reads a scalar status. Because `wait` runs in-process, it reads the status from the **pre-spill** envelope object, so the ≥32 KB spill-to-disk rule (§6) never hides the status field; status responses are small regardless.

---

## 17. Pagination & token control

```text
Return ≤ 20 items inline by default. Include count/total when the provider returns it.
Include a "next" command when a cursor is derivable. Support --limit N.
--all only with --save-json or --out (writes full set to disk, never floods stdout).
```

**Cursor caveat (validated):** ElevenLabs pagination is **not uniform** — there are three distinct cursor patterns plus one non-paginated legacy endpoint. The next-page builder branches on resource family:

| Resource | Page params | End signal | Pass back as |
|---|---|---|---|
| history | `page_size` (≤1000), `start_after_history_item_id` | `has_more` | `last_history_item_id` → `start_after_history_item_id` |
| voices (v2 `/v2/voices`) | `page_size` (≤100), `next_page_token` | `has_more` | `next_page_token` → `next_page_token` |
| voices (v1 `/v1/voices`) | — | *(non-paginated, full list)* | — |
| conversations / agents (ConvAI) | `page_size`, `cursor` | `has_more` | `next_cursor` → `cursor` |

For resources outside this table, fall back to a heuristic (`has_more` + a `last_*_id`/`next_*`/`cursor` field). Where no cursor is derivable, the envelope says so in `warnings[]` rather than emitting a wrong `next`.

**`--all` termination (specified per review m6):** the loop stops when the end-signal is false/absent OR no new cursor is produced (guards against a server that never flips `has_more`). A hard cap of 1000 pages backstops runaway loops, emitting a `warnings[]` note if hit. For the non-paginated `/v1/voices`, `--all` is a single fetch.

```json
{ "v": 1, "ok": true,
  "data": { "items": [], "count_returned": 20, "truncated": true,
            "next": { "cmd": "elv call get_history --json '{\"query\":{\"page_size\":20,\"start_after_history_item_id\":\"…\"}}'" } } }
```

---

## 18. Dependencies (trimmed in v2)

```json
{
  "dependencies": {
    "commander": "^14",
    "ajv": "^8",
    "ajv-formats": "^3",
    "@apidevtools/json-schema-ref-parser": "^11",
    "form-data": "^4",
    "music-metadata": "^10",
    "mime-types": "^2",
    "ws": "^8"
  },
  "devDependencies": { "typescript": "^5", "tsx": "^4", "tsup": "^8", "vitest": "^3" }
}
```

Changes from v1:
- **Removed `yaml`** — the spec is served as JSON; nothing reads YAML. (YAGNI.)
- **Removed `zod`** — Ajv2020 already validates all API input from the OpenAPI schemas; TypeScript types cover internal envelopes. Reintroduce *only* if a real untrusted runtime boundary needs it (config file, NDJSON event parsing) — and if so, scope it to that boundary, don't double up on API validation.
- **Added `@apidevtools/json-schema-ref-parser`** — used in `.bundle()` mode (resolve external refs, keep internal `$ref`); the 6 recursive schemas make hand-rolled deref a hang risk. `@readme/openapi-parser` is an acceptable alternative.
- **Added `ajv-formats`** — required so Ajv2020 (`strict:false`) handles `format` keywords on the OpenAPI schemas.
- **Added `form-data`** — streamed multipart for large file uploads (dubbing video); native `FormData`/`Blob` buffers the whole file (review m2).
- **Added `music-metadata`** — pure-JS mp3/mp4/wav duration probing for the per-minute credit estimates (review M4).
- **No JSONPath dep** — `wait --status-path` is dotted-path only (review m3), so no `jsonpath-plus`.
- Use `Ajv2020` from `ajv/dist/2020`.

Keep dependencies boring. No framework circus. (Six runtime deps; each earns its slot above.)

---

## 19. Repository layout

```text
elv/
  package.json  tsconfig.json  README.md  AGENTS.md
  spec/
    openapi.snapshot.json          # vendored bootstrap spec
  src/
    cli.ts
    commands/ { ops, call, http, ws, wait, config, view }.ts
    commands/aliases/ { tts, stt, music, sfx, voice-change, voice-isolate, dubbing,
                        voices, models, agents, history, usage }.ts
    core/ { client, request-builder, response-normalizer, envelope, errors, retries,
            files, config, safety, budget, redaction }.ts
    openapi/ { fetch-spec, compile-spec, compact-schema, registry, risk }.ts
    ws/ { catalog, session, events, audio-writer }.ts
    util/ { json, jsonpath, paths, hash }.ts
  fixtures/ fake-openapi.json
  tests/ { cli-json, openapi-compiler, request-builder, response-normalizer, multipart,
           safety, budget, retries, aliases, ws-session, redaction }.test.ts
```

New modules vs v1: `core/budget.ts` (spend guard), `ws/catalog.ts` (hardcoded WS endpoints), `util/jsonpath.ts` (for `wait`), `commands/view.ts` (phase 2), `spec/openapi.snapshot.json`.

---

## 20. Acceptance criteria

```text
1.  Every command emits exactly one valid JSON object to stdout (incl. ws/streaming terminal envelope).
2.  No color, spinners, progress bars, or prose on stdout by default.
3.  Failed commands exit nonzero with the documented exit-code taxonomy and a valid ErrorEnvelope.
4.  The compiler discovers all 320 operations with an operationId; excludes x-skip-spec; asserts id uniqueness.
5.  The live spec BUNDLES (internal $ref preserved) without hanging on the 6 recursive schemas.
6.  ops search finds operations by operationId, path, tag, group, summary, description.
7.  ops schema returns compact required/optional inputs from the -Input schema; --example emits a runnable call.
8.  call executes JSON, multipart, query-only, and path-param requests.
9.  Binary responses are written to files and never printed to stdout.
10. Large JSON is summarized inline and saved to disk.
11. All FOUR error detail variants normalize correctly (array / rich-object / legacy / string); code =
    detail.code ?? detail.status; param from FastAPI loc or detail.param; raw always preserved.
12. 429 branches: rate_limit_exceeded/system_busy back off; concurrent_limit_exceeded throttles, not escalate.
13. DELETE and external_side_effect ops require --yes; GETs are never gated.
14. --max-credits blocks an over-budget op pre-flight (exit 5) and text_to_speech_full/sound_generation/
    audio_isolation are budget-guarded (regression test for B1); envelope reports estimated vs charged.
15. API keys never appear in normal output, dry-run, debug logs, test snapshots, or WS session files.
16. http works for endpoints absent from the registry.
17. ws plays an NDJSON send-script and saves received events + decoded audio; credentials redacted from
    session files; rejects eleven_v3 over the catalog; auto-responds to ping with pong; drains after close.
18. Aliases produce a semantically-identical normalized request (deep-equal request-builder output) to the
    equivalent elv call — not raw bytes (multipart boundary / JSON key order differ).
19. Response parsing ignores unknown response fields.
20. CI runs unit tests with no real API key; integration tests gated behind ELEVENLABS_API_KEY.
21. config doctor gives structured pass/fail diagnostics incl. credit balance when reachable.
22. The compact registry cache is version-stamped and auto-recompiles on elv-version mismatch.
23. The OpenAPI is BUNDLED (internal $ref preserved); the compiled registry JSON-serializes despite the
    6 recursive schemas; the compact-schema generator terminates on them.
24. wait polls in-process, resolves --status-path (dotted) to success/failure values, and honors timeout.
25. Each of the 3 pagination patterns derives a correct "next" command; --all terminates and caps at 1000
    pages; --all on non-paginated /v1/voices fetches once.
26. --dry-run performs NO network call and previews even when --yes is missing or the budget is exceeded.
27. usage --from/--to converts dates to MILLISECONDS for /v1/usage/character-stats.
28. Cold start with an empty cache bootstraps from the vendored snapshot (no network required).
29. An ambiguous flat-JSON key (matches 2+ locations) is a hard error (exit 2) printing the bucketed shape.
30. With --retry-post, the budget estimate is multiplied by the max retry count.
31. streamKind json_events streams (e.g. text_to_speech_full_with_timestamps) are parsed, not piped as audio.
```

---

## 21. Implementation phases

```text
P1  Core shell contract: CLI skeleton, config loader, envelope writer + version, redaction chokepoint,
    exit-code taxonomy, files module (hashing/manifests/deterministic names), test stdout is one JSON object.
    (files.ts moved up from v1-P4 — binary-to-disk in P3 depends on it.)
P2  OpenAPI compiler: BUNDLE (not deref), vendored-snapshot bootstrap, version-stamped cache,
    x-skip-spec exclusion, -Input/-Output handling, cycle-aware compact-schema gen; ops search/get/schema.
P3  Generic REST: call, flat→bucketed normalization + ambiguity rule, Ajv2020 validation,
    response normalization, 4-variant error parsing, retries, binary + streamKind handling.
    Guards (safety/budget) present as no-op stubs so runOperation's shape is final here; real logic lands P7.
P4  Multipart & files: streamed --file uploads, file arrays, deterministic filenames, large-JSON spill,
    json_events stream parsing (base64 audio + alignment).
P5  Escape hatches: http, ws (catalog + scripted sessions + lifecycle + auto-pong + leak guard), wait.
P6  Aliases: the 12 thin wrappers; semantic-equivalence request test.
P7  Harden: risk classification + curated allowlists, --yes, costHint-keyed --max-credits guard, --dry-run
    ordering, duration probing, integration tests, README, AGENTS.md.
```

---

## 22. `AGENTS.md` (ships in repo + package)

```md
# elv agent usage
Use `elv ops search <query>` to find operations.
Use `elv ops schema <id> --example` before unfamiliar calls.
Use `elv call <id> --json …` for complete API coverage; aliases (`tts`, `stt`, `music`, `agents`, …) for common work.
Every command returns exactly one JSON object to stdout. Branch on exit code: 0 ok; 2 input; 3 auth;
4 needs --yes; 5 budget cap hit (raise --max-credits); 6 out of credits (top up); 7 retryable; 8 provider; 9 not-found.
Generated audio/video/zip/binary is saved to disk and returned in `files[]`.
Never pass API keys as args. Set `ELEVENLABS_API_KEY`.
For DELETE, outbound calls/messages, API-key mutation, and member changes, add `--yes`.
Cap spend with `--max-credits N` (or `ELV_MAX_CREDITS`); check balance with `elv usage`.
Do NOT --dry-run secret-create ops with real secret values (body is echoed).
```

---

## 23. Handoff prompt for the implementation agent

```text
Build a TypeScript/Node 22 CLI named `elv`, an agent-first wrapper around the ElevenLabs API.

Contract:
- For AI agents, not humans. Every command non-interactive; prints exactly one JSON object to stdout.
- Never print non-JSON, color, spinners, banners, or progress bars. On failure print a structured
  ErrorEnvelope to stdout and exit with the documented exit-code taxonomy.
- API key from ELEVENLABS_API_KEY via xi-api-key header; never printed/logged (single redaction chokepoint).

Core:
- OpenAPI-driven runner over the ElevenLabs OpenAPI 3.1 spec (320 ops). BUNDLE the spec (resolve external
  refs, keep internal $ref — full deref hangs on the 6 recursive schemas and won't serialize) with
  @apidevtools/json-schema-ref-parser; skip x-skip-spec; bind request validation to -Input schemas with
  Ajv2020 (strict:false + ajv-formats, validate by $ref). Ship a vendored snapshot; version-stamp the cache.
- Full coverage via `elv call <operation_id>` for every op + `elv http <method> <path>` escape hatch.
- `elv ws` plays scripted NDJSON sessions against a hardcoded WS catalog (WS isn't in OpenAPI): owns the
  session lifecycle (drain after close / inactivity timeout), auto-pongs, rejects eleven_v3, redacts
  credentials from all session files. ConvAI is interactive — out of scope for the scripted player.
- `elv ops search|get|schema` for token-efficient discovery (deterministic ranking); `schema --example`
  emits a runnable call.
- Save binary/large output to files: path, mime, bytes, sha256 (size-capped). Stream to disk; never
  arrayBuffer binary. Branch streaming on streamKind (audio_bytes pipe / json_events parse / text).
- Capture request-id / x-trace-id (success + error) + character-cost / song-id / Content-Disposition /
  concurrency-headroom headers into the envelope.
- Normalize all FOUR error detail variants (FastAPI 422 array; current rich object with code/type/param/
  request_id; legacy {status,message}; bare string) keyed on typeof detail; code = detail.code ?? status;
  param from loc or detail.param; preserve raw.
- 429 branches: rate_limit/system_busy back off; concurrent_limit throttle-and-drain. No idempotency, so
  POST is not auto-retried (--retry-post opts in and multiplies the budget estimate).
- Require --yes for destructive + external-side-effect ops (GETs never gated).
- --max-credits / ELV_MAX_CREDITS pre-flight budget guard keyed on costHint (NOT the risk label — TTS/SFX/
  isolation must be guarded); upper-bound estimate; report estimated vs charged (charged only when a cost
  header is returned, else null).
- ~12 thin aliases that build AgentInput and call the SAME runner (semantic-equivalence request test).
- Exit codes branch on body code, not HTTP status (consistent 400-vs-422 and 401-vs-402 quota).

Do not hand-write hundreds of endpoint-specific commands. The generic runner is the completeness layer;
aliases are ergonomic sugar.
```

---

## 24. Validation status

| Area | Status | Source |
|---|---|---|
| 320 ops, all have unique operationId | ✅ confirmed | live `openapi.json` 2026-06-25 |
| Fern extensions (`x-fern-sdk-group-name`, `x-fern-streaming`, `x-fern-sdk-streaming`) | ✅ confirmed | live spec |
| `x-skip-spec` exists (1 op) | ✅ confirmed | live spec |
| Binary content types (`audio/mpeg`, `audio/*`, `application/zip`) | ✅ confirmed | live spec |
| 27 multipart endpoints | ✅ confirmed | live spec |
| 6 recursive schemas (deref hazard) | ✅ confirmed | live spec |
| `-Input`/`-Output` schema split | ✅ confirmed | live spec |
| Documented headers `character-cost`, `song-id`, `Content-Disposition` | ✅ confirmed | live spec |
| FastAPI 422 error shape (`detail:[{loc,msg,type}]`) | ✅ confirmed | live spec (`HTTPValidationError`) |
| 4 error-body variants (array / rich-object / legacy `{status,message}` / string) | ✅ confirmed | docs/eleven-api/resources/errors + help center + SDK issues |
| Machine-readable code catalog + terminal-vs-retryable | ✅ confirmed | docs/eleven-api/resources/errors |
| `request-id`/`x-trace-id` headers on success + error; `request_id` in body | ✅ confirmed | docs/api-reference/introduction |
| 429 branches (rate-limit backoff vs concurrency throttle); no documented `Retry-After`; concurrency-headroom headers | ✅ confirmed | docs/eleven-api/resources/errors |
| No idempotency mechanism (POST retry double-charge risk) | ✅ confirmed (negative) | docs/api-reference/authentication |
| WS catalog (4 endpoints), auth, base64-audio protocol, no-v3-over-WS, timeouts | ✅ confirmed | AsyncAPI docs (stream-input / multi-stream-input / stt realtime / convai) |
| Credit/cost model per modality; TTS client-estimable (shared-voice lower-bound caveat) | ✅ confirmed | elevenlabs.io/pricing + help center |
| Balance (`/v1/user/subscription`) + usage (`/v1/usage/character-stats`, ms units) | ✅ confirmed | docs/api-reference/user + usage |
| Pagination: 3 patterns + 1 non-paginated, per-resource cursor table | ✅ confirmed | docs/api-reference history/voices/convai |

**Residual open questions to verify against live API traffic (low-risk, documented in-code):** exact Flash/Turbo per-char ratio (range 0.5–1 by plan); whether `character-cost` is emitted on non-TTS generation endpoints; dubbing per-language multiplier (third-party-sourced); whether `Retry-After`/`X-RateLimit-*` headers ever appear; ConvAI signed-URL token param name (`token` vs `conversation_signature`).
```
