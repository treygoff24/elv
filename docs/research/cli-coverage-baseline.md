# ElevenLabs CLI coverage baseline

**Audited:** 2026-07-16
**Scope:** live repository only; no web research and no comparison to a newer upstream API specification
**Baseline:** `main` at the start of the audit, vendored `spec/openapi.snapshot.json`

## Executive verdict

The CLI has a strong generic REST foundation, but it does **not yet meet the literal goal of complete, safe, usable ElevenLabs service coverage**.

- The vendored OpenAPI snapshot contains 320 HTTP operations. The compiler intentionally excludes one `x-skip-spec` operation, so `elv call` registers **319 operations**, not the 320 claimed in the README. The omitted operation is the deprecated `get_signed_url_deprecated`; `elv http` can still reach its path.
- The generic runner can construct JSON and multipart requests, validate bodies, stream or spill responses, normalize errors, paginate several common shapes, and enforce selected safety/cost rules. This is the strongest part of the tool.
- The raw HTTP escape hatch reaches arbitrary REST paths, but it does not inherit matched operations' cost metadata. Its `--max-credits` guard therefore has no practical estimate even for known paid endpoints.
- WebSocket coverage is a protocol-specific TTS-oriented script player, not a general WebSocket equivalent of `call`. Conversational AI is explicitly rejected; outbound frames are JSON-only; every script must begin with the TTS keep-alive text; and common `--dry-run`, `--yes`, and `--max-credits` flags are ignored.
- New models are discoverable dynamically through `models list`, and most aliases pass model IDs through without local hard-coding. However, model compatibility and real-time defaults are hard-coded in places, the configured `default_model_id` is unused, and stale OpenAPI enums can reject newly launched model IDs.
- Automatic spec refresh exposes new REST operations mechanically, but new operations default to unknown billing semantics and heuristic risk classification. **289 of the 319 registered operations have `costHint: unknown`**, so `--max-credits` is not a complete budget boundary.
- The test suite is substantial and currently green, but live coverage is three read-only checks. It does not prove paid generation, new model compatibility, spec drift, token-producing endpoints, or the real ElevenLabs WebSocket protocols.

The right expansion strategy is to preserve the generic engine, refresh and diff the upstream contract, then close the cross-cutting safety, secret-output, streaming, and protocol gaps before adding more hand-written aliases.

## What was inspected

- `AGENTS.md`, `README.md`, `package.json`
- all `src/` command, OpenAPI, core, utility, and WebSocket modules
- all 55 test files under `tests/`
- `spec/openapi.snapshot.json`
- Git history for the vendored snapshot

The snapshot was introduced in commit `95e7cbc` on 2026-06-25. It is OpenAPI 3.1, reports the generic API version `1.0`, has no source revision/fetched-at metadata, and is a 1.7 MB single-line JSON file.

## Baseline inventory

### Vendored REST contract

| Metric | Current baseline |
| --- | ---: |
| OpenAPI path operations | 320 |
| Registered `elv call` operations | 319 |
| Explicitly skipped operations | 1 |
| GET | 122 in raw snapshot; 121 registered after skip |
| POST | 139 |
| PATCH | 24 |
| DELETE | 34 |
| PUT | 1 |
| JSON request bodies | 126 |
| Multipart request bodies | 27 |
| Operations with binary responses | 23 |
| Deprecated registered operations | 18 |

The single skipped operation is:

```text
GET /v1/convai/conversation/get_signed_url
operationId: get_signed_url_deprecated
```

The compiler currently assigns these semantics:

| Classification | Count |
| --- | ---: |
| Read | 121 |
| Mutate | 99 |
| Destructive | 36 |
| External side effect | 33 |
| Generate | 30 |

| Stream kind | Count |
| --- | ---: |
| None | 308 |
| Audio bytes | 8 |
| JSON events | 2 |
| Text | 1 |

| Cost hint | Count |
| --- | ---: |
| Unknown | 289 |
| Characters | 8 |
| Per generation | 7 |
| Per source minute | 6 |
| Audio seconds | 5 |
| Voice slot | 4 |

The snapshot is broad. Its non-exclusive tags include 134 Agents Platform operations, 47 dubbing tags, 27 workspace tags, 23 Studio tags, 18 voices tags, 14 PVC tags, 11 productions tags, nine pronunciation-dictionary tags, six music-generation tags, five Speech Engine tags, plus TTS, dialogue, STT, speech-to-speech, audio isolation, audio native, forced alignment, text-to-voice, models, history, and usage.

### Curated command surface

There are 12 alias families covering 30 distinct operation IDs:

| Alias | Covered workflows |
| --- | --- |
| `tts` | Four full/stream and timestamp combinations; voice ID or name resolution |
| `stt` | Upload/transcribe; optional transcript polling |
| `music` | Generate and stream compose |
| `sfx` | Sound generation |
| `voice-change` | Full and streaming speech-to-speech |
| `voice-isolate` | Audio isolation |
| `dubbing` | Create, get, audio, list; optional completion polling |
| `voices` | List, find, get, instant clone |
| `agents` | List, get, create, update, simulate |
| `models` | List models |
| `history` | List, audio, delete |
| `usage` | Subscription or character statistics |

Everything else depends on `ops` discovery plus `call`, or the lower-level `http` escape hatch. That is reasonable architecture, but it is not equivalent to first-class workflow coverage for Studio, Speech Engine, text-to-dialogue, voice design/PVC, pronunciation dictionaries, audio-native, productions/orders, the large Conversational AI subservices, or workspace administration.

### WebSocket catalog

`src/ws/catalog.ts` contains four entries:

| Name | Path | Marked scriptable | Default model |
| --- | --- | ---: | --- |
| `tts-realtime` | `/v1/text-to-speech/{voice_id}/stream-input` | yes | `eleven_flash_v2_5` |
| `tts-multi` | `/v1/text-to-speech/{voice_id}/multi-stream-input` | yes | `eleven_flash_v2_5` |
| `stt-realtime` | `/v1/speech-to-text/realtime` | yes | `scribe_v2_realtime` |
| `convai` | `/v1/convai/conversation` | **no** | none |

Raw `ws://`, `wss://`, and configured-host paths are accepted, but the player is not protocol-neutral; see the gap analysis below.

## Architecture map

### 1. Spec compilation and registry

`src/openapi/compile-spec.ts` bundles refs and compiles each path operation into an `OperationCard` containing method/path, groups/tags, parameters, one preferred request media type, response media types, stream kind, risk, cost hint, deprecation state, and examples.

Important behavior:

- Supported methods are GET, POST, PUT, PATCH, DELETE, and HEAD.
- Request media preference is JSON, multipart, octet-stream, text, then the first remaining media type.
- Path/query/header parameters are recorded. Cookie parameters and OpenAPI security/server semantics are not modeled.
- Stream classification depends on Fern streaming extensions plus the declared success content type.
- Risk and cost are supplied by `src/openapi/risk.ts`, not derived comprehensively from upstream billing metadata.
- `x-skip-spec` removes an operation from the generic registry.

`src/openapi/registry.ts` writes a compiled cache containing both operation cards and the bundled spec. The cache is namespaced by the CLI package version, currently `0.1.0`. On a cold start it prefers a previously downloaded raw spec, then falls back to the vendored snapshot.

### 2. Discovery

`elv ops search`, `ops get`, and `ops schema` expose the registry. The schema command can return compact required/optional buckets, the raw request schema, or a runnable `elv call` skeleton. Unknown operation IDs get nearest-ID suggestions.

This is a useful agent surface and should remain the primary way to handle the long tail. Full coverage should improve its freshness and metadata rather than replacing it with hundreds of hand-written commands.

### 3. Generic `call`

`src/core/client.ts` is the common operation runner:

1. Load the registry and operation card.
2. Normalize flat or bucketed input into `path`, `query`, `headers`, `body`, and `files`.
3. Apply selected pagination defaults.
4. Check required parameters and validate the request body with Ajv 2020.
5. Estimate credits using the curated cost table.
6. Run dry-run, confirmation, and budget preflights.
7. Build a request, retry safe methods (and POST only with `--retry-post`), normalize the response, and spill large/binary output.

Request construction supports:

- encoded path substitution;
- repeated query parameters for arrays;
- arbitrary header buckets, with the profile API key forced into `xi-api-key`;
- JSON and simple non-JSON serialization;
- native streaming multipart uploads, arrays of files, MIME inference, and a 2 GiB default upload cap.

Validation is stronger for bodies than parameters. Required path/query/header presence is checked, but parameter types, ranges, formats, and enums are not validated. Body validation can reject newly valid enum values until the local spec is refreshed.

### 4. Raw `http`

`elv http` accepts arbitrary paths and the same six HTTP methods, JSON bodies, multipart files, pagination flags, output controls, and common runner flags. It attempts to match known registry paths so risk gating remains consistent. Unknown paths fall back to method/name heuristics.

However, it creates a synthetic operation with `operationId: http` and does not copy the matched operation's cost hint or stream metadata. Consequences:

- known paid endpoints receive a null credit estimate;
- `--max-credits` cannot block them;
- JSON-event streaming endpoints are treated as ordinary JSON rather than event streams;
- the README statement that the escape hatch shares the same budget behavior as `call` is materially overstated.

### 5. Response and output handling

The response normalizer handles:

- JSON inline responses;
- large JSON spill with summaries and `view` hints;
- binary/audio/zip streaming to disk;
- timestamped audio plus JSON sidecars;
- Fern-classified JSON event streams to NDJSON plus decoded audio;
- invalid provider JSON as a normalized error;
- request IDs, trace/song IDs, concurrency headers, credit headers, and retry guidance.

Files are collision-safe and usually hashed; hashes are skipped above 64 MiB unless `--hash` is set. The envelope writer is the single stdout redaction chokepoint and emits exactly one JSON object plus newline.

### 6. Pagination and waiting

Pagination knows explicit history, v1/v2 voices, and Conversational AI families, then falls back to common `next_*`, `cursor`, and `last_*_id` response fields. Only operations with `page_size` (plus a few named exceptions) are considered paginated. Offset/page-number and differently named cursor APIs will remain callable one page at a time but will not get reliable `--all` behavior.

`elv wait` can poll an operation or an arbitrary subprocess and extract a dotted path. The STT and dubbing aliases provide configured wait-after-create flows. The standalone wait command exposes common CLI flags, but does not pass profile/base URL or other runner options into its polling calls.

### 7. Safety, budget, retries, and auth

The safety classifier guarantees:

- all GET/HEAD operations are reads;
- all DELETE operations are destructive;
- named/naming-pattern admin, credential, outbound, and messaging operations are external side effects;
- a curated set of generation endpoints gets generate/cost semantics.

Only destructive and external-side-effect operations require `--yes`. Budget enforcement occurs only when a non-null estimate exceeds the configured ceiling. Unknown estimates pass through even when the user explicitly supplied `--max-credits`.

The configuration system supports profiles, custom API-key environment variable names, residency hosts, output/cache directories, and a default model ID. `default_model_id` is resolved and displayed but is never applied by an alias or the generic runner.

## Model handling

### What already adapts well

- `models list` calls `/v1/models` at runtime, so the discoverable model list is not compiled into the CLI.
- TTS, STT, music, SFX, and voice-change aliases accept a string model ID and pass it to the generic runner.
- Generic calls can use any model exposed by the active registry schema.
- Raw HTTP can bypass stale body validation if an endpoint/model launches before a spec refresh.

### Gaps and drift risks

- `default_model_id` in profiles is dead configuration.
- TTS and multi-stream WS catalog defaults hard-code `eleven_flash_v2_5`; STT realtime hard-codes `scribe_v2_realtime`.
- WS explicitly blocks `eleven_v3`, including raw WS targets, based on a hard-coded compatibility rule.
- The snapshot contains model enums for music (`music_v1`, `music_v2`), STT (`scribe_v1`, `scribe_v2`), and voice design. New model IDs can be rejected by Ajv until `spec update` is run.
- There is no local capability map connecting models to modalities, languages, streaming support, output formats, deprecations, or endpoint compatibility.
- There are no tests that compare alias defaults/validation against the live `/v1/models` response.

## Spec update and freshness flow

`elv spec update` can fetch the fixed URL `https://api.elevenlabs.io/openapi.json`, a supplied URL/file, or recompile the vendored snapshot offline. It writes a raw cache and compiled registry under the versioned cache directory.

Current limitations:

1. **A runtime update does not update the vendored snapshot.** New installs and clean caches continue to receive the June 25 snapshot until a repository change is made.
2. **No drift report exists.** The command reports counts but not added/removed/changed operation IDs, models, schemas, media types, deprecations, or risk/billing coverage.
3. **No provenance is recorded beyond `generated_at`.** There is no upstream ETag, Last-Modified, content digest, fetch URL in the cache envelope, or vendored metadata file.
4. **Cache identity is the package version, not the spec digest.** Multiple upstream revisions share one namespace.
5. **The default URL is duplicated and fixed.** `loadConfig` resolves `ELV_SPEC_URL`, but `updateSpecCache` does not use it.
6. **Fetch has no explicit timeout, retry, authentication, or residency-aware behavior.**
7. **Raw cache is written before compilation succeeds.** A structurally invalid but valid-JSON spec can replace the raw cache and then fail compilation, leaving the next cold load pointed at the bad source.
8. **There is no post-refresh safety audit.** Newly exposed operations can be callable with `risk: mutate` and `costHint: unknown` without any explicit review.

## WebSocket coverage gap

This is the largest mismatch with the phrase "everything possible with the API."

The player in `src/ws/events.ts` and `src/ws/session.ts` has these global assumptions:

- every send script is NDJSON containing only `{ "type": "send", "data": { ... } }` or close records;
- the first send must have `data.text` equal to whitespace, a TTS keep-alive convention;
- outbound messages are JSON text only;
- inbound frames must parse as JSON;
- audio is extracted from known base64 event fields;
- there are no binary/file frame actions, delays, waits for server events, conditional sends, protocol-specific handshakes, or interactive duplex control.

As a result:

- `convai` is cataloged but explicitly refused as interactive.
- `stt-realtime` is labeled scriptable but has no protocol-specific integration test, and the universal TTS first-message rule plus lack of binary/file actions makes real transcription coverage unproven and likely incomplete.
- A raw WS URL does not escape those assumptions.
- `--dry-run`, `--yes`, `--max-credits`, `--retry-post`, and `--debug` are accepted because common flags are registered, but `wsRunOptions` forwards only base URL and profile. The safety/budget claim in the README is therefore false for WS.
- The only black-box WS integration uses a local mock shaped around the current player; there is no live ElevenLabs WS check.

Full real-time coverage needs protocol adapters or a genuinely general scripted transport. Merely adding more catalog URLs will not solve this.

## Secret-producing operation gap

The generic redactor is safe for ordinary logs but conflicts with endpoints whose purpose is to return a credential:

- response keys exactly named `token` are always redacted, so `get_single_use_token` cannot return its intended value inline for agent chaining;
- `conversation_token` and `signed_url` are not core secret keys and can be emitted to stdout, while the WS-specific redactor does recognize `signed_url`;
- `--save-json` writes the unredacted data before envelope redaction, creating an undocumented workaround and a secret-at-rest risk; general file writes do not explicitly request restrictive permissions.

Complete service coverage requires an intentional secret-result contract: for example, restrictive file-only output with a redacted envelope, or an explicit opt-in that preserves the one-envelope rule without leaking through debug/error paths. The current mix both disables one legitimate workflow and leaks adjacent credential shapes.

## Prioritized gaps and risks

### P0: correctness and trust boundaries

1. **Refresh and vendor the current official API contract with a machine-readable diff.** The repository cannot claim current coverage from a June 25 snapshot without comparing it to upstream.
2. **Make spec refresh transactional and provenance-aware.** Compile/validate first, then atomically replace raw and compact caches; record digest/source/fetch metadata.
3. **Make budget semantics honest across all transports.** Raw HTTP must inherit matched cost metadata; WS must either implement budget/dry-run behavior or stop advertising/accepting those flags. Decide whether explicit `--max-credits` should fail closed when estimation is unavailable.
4. **Fix secret-result handling.** Token/signed-URL/WebRTC-token endpoints need consistent field classification and a usable, secure output path.
5. **Replace the TTS-only WS abstraction for STT and Conversational AI coverage.** Add protocol-specific actions/adapters and live smoke coverage.

### P1: complete adaptive REST coverage

6. **Audit every added/changed upstream operation for risk, billing, streaming, multipart files, and async lifecycle.** Automatic registration alone is insufficient.
7. **Derive more behavior from OpenAPI.** Validate parameter schemas; retain all request media types with a content-type selector; model cookie/security/server semantics if upstream uses them; derive pagination from parameter/response schemas rather than a short family list.
8. **Make model handling coherent.** Apply or remove `default_model_id`; avoid silently stale WS defaults; surface endpoint/model compatibility and deprecation; test current live model IDs against alias/schema acceptance.
9. **Preserve forward compatibility.** When a fresh model is rejected only by a stale enum, emit a targeted refresh hint or provide an explicit validated bypass rather than a generic failure.
10. **Propagate standalone `wait` configuration.** Profile, base URL, and applicable runner behavior should match the operation being polled.

### P2: first-class usability and claims

11. **Add thin aliases only for high-value multi-step workflows**, not one wrapper per REST endpoint. Candidates are text-to-dialogue, voice design/PVC, Studio, pronunciation dictionaries, Speech Engine, knowledge base/tools, batch calling, and productions.
12. **Generate service-area inventory/documentation from the active registry.** The agent should be able to list groups and see which operations are alias-backed, async, billable, destructive, streaming, deprecated, or upload-based.
13. **Correct README claims.** Say 319 registered from the current vendored snapshot plus raw REST escape coverage, or stop printing a static count and derive it during release.

## Test posture

Current local verification:

```text
npm run typecheck  PASS
npm test           PASS: 55 files, 293 tests
npm run lint       PASS
```

Because `ELEVENLABS_API_KEY` was present, the three read-only live integration tests ran and passed:

- `models list`
- `voices list`
- `ops search "text to speech"`

Strong existing test areas include the one-envelope contract, exit codes, redaction, retries, budget gates for selected generation endpoints, multipart uploads, large-result spilling, pagination, schema compilation, aliases, waits, and local mock WebSocket sessions.

Missing acceptance coverage for the expansion goal:

- an automated live-spec diff and compile gate;
- a test that every registered paid operation has an explicit budget policy;
- a test that every destructive/external operation has the intended confirmation policy;
- raw HTTP inheritance of risk/cost/stream semantics;
- token, signed URL, and WebRTC credential output behavior;
- live paid generation smoke tests with a tiny explicit ceiling;
- live TTS realtime, STT realtime, and Conversational AI WS protocol tests;
- newly launched model IDs and model/endpoint compatibility;
- representative endpoints from Studio, Speech Engine, PVC, productions, knowledge base/tools, batch calls, and workspace administration;
- failure-atomic spec refresh and cache rollback;
- pagination families beyond history, voices, and common Conversational AI cursors;
- common-flag parity tests for `http`, `ws`, and standalone `wait`.

## Definition of full coverage

For this CLI, "full ElevenLabs service coverage" should mean all of the following, not merely a high operation count:

1. Every current documented REST operation is discoverable and callable, or explicitly excluded with a documented reason and an escape path.
2. Every documented real-time protocol has a working transport workflow, not only a catalog URL.
3. New models can be discovered and used without code changes unless the provider requires endpoint-specific behavior.
4. Every paid operation has explicit budget semantics: accurate estimate, conservative bound, or a visible fail-closed/unknown policy.
5. Every destructive, outbound, credential, and workspace-admin operation has reviewed confirmation and redaction behavior.
6. Every request/response media type used by the live service can be represented without hand-written raw `curl` logic.
7. Async operations have a discoverable status/wait workflow.
8. The vendored snapshot, runtime cache, README count, and release tests all describe the same upstream revision.
9. Live smoke tests cover each transport and major service family with strict spend and mutation controls.

The current codebase is close on item 1 for the June 25 REST snapshot and strong on the basic agent/output contract. Items 2, 4, 5, and 8 are the main blockers to an honest whole-service claim.
