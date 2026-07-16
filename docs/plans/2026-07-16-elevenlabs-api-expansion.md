# ElevenLabs API expansion plan

**Date:** 2026-07-16
**Target:** `eleven-agent-cli` (`elv`) on the current `main` branch
**Upstream point in time:** official OpenAPI SHA-256 `de0476611805f3ee4e6a6c76dcdd6cc9686b8daee5757e6465d2974094c844ce`
**Execution rule:** commit locally in coherent checkpoints; never push during this workflow

## Decision

Keep `elv call` as the full REST surface and make that surface current, inspectable, safe, and protocol-correct. Do not hand-write hundreds of aliases. Add aliases only for the post-baseline workflows where a generic JSON call is materially worse: detailed Music streaming, agent tests/RAG, workspace members/service accounts, and Dubbing Project editing.

This plan treats "full API coverage" as the published OpenAPI and client-side AsyncAPI/WebSocket contracts. It does not reverse-engineer private ElevenCreative endpoints for Image & Video, Avatars, Ads Engine, Flows, or other UI-only products. Those products are documented, but ElevenLabs has not published stable API contracts for them.

## Confirmed baseline

The vendored snapshot has 320 documented operations, 319 callable operations, 256 paths, and 1,284 schemas. The official live OpenAPI fetched on 2026-07-16 has 339 documented operations, 338 callable operations, 268 paths, and 1,345 schemas. It adds 19 operation IDs and removes none. The existing compiler already compiles all 338 callable operations.

The 19 new operations are:

- `compose_detailed_stream`
- `create_service_account`
- `get_workspace_members`
- `query_agent_knowledge_base_rag_route`
- `dubbing_project_create`, `dubbing_project_list`, `dubbing_project_get`, `dubbing_project_delete`
- `dubbing_language_create`, `dubbing_language_list`, `dubbing_language_get`, `dubbing_language_delete`
- `dubbing_transcript_get`, `dubbing_transcript_segment_add`, `dubbing_transcript_segment_update`, `dubbing_transcript_segment_delete`
- `dubbing_target_transcript_get`, `dubbing_target_transcript_segment_update`, `dubbing_target_transcript_regenerate`

July 6 also deprecated the two conversation-simulation operations used by `elv agents simulate`. ElevenLabs now directs callers to `create_agent_response_test_route` followed by `run_agent_test_suite_route`. July 13 added service-account creation, workspace-member listing, `run_subagent` agent-tool schemas, nested transfers, sentiment settings, and MCP environment scoping.

The current documented model families are:

| Area | Current model IDs |
| --- | --- |
| Text to Speech | `eleven_v3`, `eleven_multilingual_v2`, `eleven_flash_v2_5`, `eleven_flash_v2` |
| Text to Voice | `eleven_ttv_v3`, `eleven_multilingual_ttv_v2` |
| Speech to Speech | `eleven_multilingual_sts_v2`, `eleven_english_sts_v2` |
| Speech to Text | `scribe_v2`, `scribe_v2_realtime` |
| Sound Effects | `eleven_text_to_sound_v2` |
| Music | `music_v2`, `music_v1` |

`eleven_turbo_v2_5`, `eleven_turbo_v2`, and `scribe_v1` are deprecated. The provider announced removal of the v1 TTS models on July 9, but the tested workspace still returned them on July 16. The CLI must report deprecation without hard-rejecting server-enabled IDs.

Primary evidence is captured in:

- `docs/research/elevenlabs-api-2026-07-16.md`
- `docs/research/openapi-spec-drift-2026-07-16.md`
- `docs/research/cli-coverage-baseline.md`

## External review disposition

Claude and Grok both returned **approve with revisions**. Their complete
read-only reviews are in `docs/reviews/plan-review-claude.md` and
`docs/reviews/plan-review-grok.md`.

| Review theme | Disposition in this revision |
| --- | --- |
| A raw/compact two-file swap cannot be atomic | Accepted. The compiled cache envelope, including its bundled raw spec and provenance, becomes the single authoritative runtime artifact. |
| HTTP template matching is order-dependent | Accepted. Matching is specificity-ranked with deterministic ambiguity handling. |
| Secret results can still leak or become unusable | Accepted. The secret key set, `--save-json`, redaction, and `view` behavior are explicit below. |
| Budget ceilings ignore resolved env/profile config | Accepted. One resolved ceiling feeds every transport, with honest unknown/unbounded states. |
| Realtime STT needs binary send support | Accepted. The WS script contract gains file/binary actions and binary receive files; agent conversation claims remain limited to the scripted public protocol. |
| Paid SSE output should survive a trailing malformed frame | Accepted. Valid partial files are preserved and marked partial on stream failure. |
| Music and Dubbing aliases were too broad | Accepted. Only workflows with a material ergonomic gap get aliases; all other operations remain available through `call`. |
| Spec provenance needs size/trust limits | Accepted. Refresh records hashes, caps downloads, and never follows upstream server URLs for request routing. |

## Approaches considered

### 1. One alias per API operation

This would make the CLI look broad while duplicating the OpenAPI registry in handwritten code. It would create 338 drift points, increase release work every week, and still fail on new endpoints between releases. Reject.

### 2. Generic engine plus adaptive discovery and thin workflows

The existing registry, validator, request builder, response normalizer, and raw escape hatches already provide the right foundation. Refresh the contract, expose service coverage and provenance, fix cross-cutting safety/protocol defects once, and add only high-value workflow aliases. Choose this approach.

### 3. Raw passthrough only

Relying only on `elv http` or unvalidated WebSockets would technically reach endpoints but would discard schema validation, risk metadata, pagination, budget protection, binary handling, and agent-facing discovery. Reject.

## Product contract after implementation

An agent must be able to do all of the following without outside documentation:

1. Run `elv capabilities` to learn the CLI version, active spec identity, REST operation counts, service groups, alias families, WebSocket catalog, environment variables, exit codes, and safety semantics.
2. Run `elv ops list` to enumerate the active API by group, method, risk, stream kind, cost policy, upload requirement, or deprecation status.
3. Run `elv spec status` to see vendored and active-cache provenance, hashes, counts, and whether the active cache differs.
4. Run `elv spec diff` or `elv spec update --dry-run` to fetch and compile a candidate spec without writing files, then receive exact added, removed, changed, and newly deprecated operations.
5. Run `elv spec update` to atomically replace a validated runtime cache. A malformed or un-compilable candidate must leave the last known-good cache untouched.
6. Call every one of the 338 current REST operations through `elv call`, with `elv http` retained for unpublished or just-launched paths.
7. Receive parsed NDJSON metadata plus decoded audio for Music detailed SSE instead of a raw event-stream dump.
8. Use the current agent-testing APIs without silently relying on deprecated simulation routes.
9. Use named workflows for workspace, RAG, and transcript-edit operations where they reduce error-prone JSON, while retaining `call` as the canonical long-tail path.
10. Use named WebSocket catalog entries for TTS, multi-context TTS, realtime STT, agent conversations, and enterprise conversation monitoring, with protocol-specific validation rather than one global TTS handshake rule.
11. Preview WebSocket targets and scripts through `--dry-run`, and receive `--yes` protection for monitor controls or other outward actions.
12. Retrieve short-lived tokens and signed URLs through a restrictive file-only secret-result contract rather than receiving a useless `[REDACTED]` value or an accidental stdout leak.

## Scope boundaries

### In scope

- Official REST OpenAPI at the pinned hash above.
- Official client-side WebSocket APIs: TTS, multi-context TTS, realtime STT, agent conversation, and enterprise conversation monitoring.
- Music detailed SSE.
- Public API deprecations and current model guidance.
- Agent-first discovery, one-envelope output, safety, budget, redaction, and deterministic tests.
- Current aliases plus the narrow additions in this plan.

### Out of scope

- Private or UI-only ElevenCreative endpoints.
- Hosting the Speech Engine upstream WebSocket server. ElevenLabs is the client in that protocol; it needs a separate server product, not another `elv ws` catalog entry.
- Paid live generation in the automated test suite.
- Promising exact credit estimates for endpoints whose provider billing inputs are not documented.
- Hard-coded rejection of deprecated model IDs that the provider still enables for an account.
- A bespoke command for every REST operation.

## Workstream A: current, transactional API contract

### A1. Refresh the vendored snapshot

Replace `spec/openapi.snapshot.json` with the pinned official document. Add `spec/openapi.snapshot.meta.json` containing:

```json
{
  "schema": "elv.openapi.snapshot.v1",
  "source": "https://api.elevenlabs.io/openapi.json",
  "retrieved_at": "2026-07-16T17:25:54Z",
  "sha256": "de0476611805f3ee4e6a6c76dcdd6cc9686b8daee5757e6465d2974094c844ce",
  "paths": 268,
  "total_operations": 339,
  "callable_operations": 338,
  "skipped_operations": 1,
  "schemas": 1345
}
```

The metadata is release provenance, not a runtime source of truth. Tests must recompute the hash and counts. Add it to the npm `files` allowlist so packaged installs retain release provenance.

### A2. Compile before writing

Refactor spec refresh so it:

1. fetches or reads the candidate;
2. parses and compiles entirely in memory;
3. computes provenance and a diff against the active baseline;
4. returns immediately in dry-run mode;
5. creates one authoritative cache envelope containing the compiled cards, bundled raw spec, source, retrieval time, SHA-256, and counts;
6. writes that envelope to a same-directory temporary file and atomically renames the single file into place.

The legacy raw cache may be read once for migration but is never an independently authoritative generation. Cold-start compilation and explicit update use the same atomic cache writer. Old cache envelopes without provenance remain loadable and report `provenance: unknown` until refreshed.

The configured `ELV_SPEC_URL` must be honored. Network fetches get a bounded timeout and maximum byte count. The CLI records the exact source and digest but never adopts the OpenAPI document's `servers` entries as request destinations. Failed fetch, JSON parse, ref bundle, duplicate operation ID, oversize response, or cache write errors return one structured error and preserve the old cache.

### A3. Add status and diff

Add:

```text
elv spec status
elv spec diff [--from FILE_OR_URL] [--offline]
elv spec update [--from FILE_OR_URL] [--offline] [--dry-run]
```

`status` is offline and read-only. `diff` fetches/compiles but never writes. `update --dry-run` is behaviorally identical to `diff`, except for `cmd` in the envelope.

The diff contract includes:

- old and candidate provenance;
- total/callable/skipped operation, path, and schema counts;
- added and removed operation IDs;
- changed operation IDs based only on upstream-derived canonical fields;
- separately labeled local curation changes for risk, cost, and stream metadata;
- newly deprecated and no-longer-deprecated operation IDs;
- added and removed schema names;
- a summary count for changed same-name schemas.

Large lists may spill through the existing file mechanism, but the summary and next action remain inline.

### A4. Tests

- Assert 339 raw, 338 callable, one skipped, and 1,345 schemas.
- Assert all 19 new IDs compile and every existing alias ID still resolves.
- Assert the metadata hash and counts match the snapshot bytes.
- Assert dry-run and diff do not create or modify cache files.
- Assert a bad candidate cannot replace a good cache.
- Assert a simulated interruption before the final rename leaves the old authoritative cache loadable.
- Assert both cold-start and explicit-update writers use the same atomic helper.
- Assert added/removed/deprecated diff output is stably sorted.

## Workstream B: discoverability and service coverage

### B1. Add `elv capabilities`

Return a bounded machine contract with:

- CLI/envelope versions;
- active spec provenance and counts;
- command families and short descriptions;
- service groups with operation counts;
- alias families and their backed operation IDs;
- WebSocket catalog summary;
- exit-code dictionary;
- environment variables and precedence notes;
- safety classes, confirmation behavior, cost-policy values, and stream kinds;
- exact next commands for `ops list`, `ops schema`, `spec status`, and `config doctor`.

Do not inline all operation cards. The complete inventory belongs in `ops list`.

### B2. Add `elv ops list`

Support filters:

```text
--group <name>
--method <GET|POST|PUT|PATCH|DELETE|HEAD>
--risk <read|mutate|generate|external_side_effect|destructive>
--stream <none|audio_bytes|json_events|sse_events|text>
--cost <policy>
--deprecated
--uploads
--limit <n>
```

Results are sorted by operation ID and contain only the fields an agent needs to choose the next call. Empty valid filters return exit 0 with `items: []` and `count: 0`.

### B3. Surface deprecation everywhere

- `ops search` results include `deprecated` and `cost_hint`.
- `ops get` already contains the flag; add a warning and replacement hint when the description names one.
- `ops schema` includes a warning for deprecated operations.
- Successful and dry-run invocation envelopes include a deprecation warning when the active operation is deprecated.
- `agents simulate` remains as a compatibility alias but its help and every result identify it as deprecated and point to `agents tests create` plus `agents tests run`.

### B4. Tests

- Pin the capability envelope schema and stable sort order.
- Prove each filter and the valid-empty-result contract.
- Prove deprecated operations emit warnings without being blocked.
- Prove bare `elv`, `elv capabilities`, `elv ops`, and `elv ops list` remain one-envelope commands.

## Workstream C: correct transport semantics

### C1. Make raw HTTP inherit matched operation metadata

When `elv http METHOD /concrete/path` matches a registry operation, reuse its operation ID, risk, cost hint, stream kind, response media, deprecation state, secret-result policy, and pagination metadata while retaining the concrete request path and caller-supplied body/files. This fixes current budget and streaming parity claims for known paths.

Template matching is deterministic: exact literal paths win first, then more literal segments, then fewer parameters, with operation ID as the final stable tie-break. If equally specific templates imply different safety metadata, reject the match as ambiguous rather than choosing by registry iteration order. Live and dry-run envelopes identify whether metadata was matched or inferred.

Unknown paths keep the synthetic `http` operation and heuristic risk. Dry-run output must say whether metadata came from a registry match or fallback inference.

### C2. Fail closed when a requested generation budget cannot be estimated

Resolve one effective credit ceiling from the explicit flag, environment, or profile using the documented precedence, and pass it to REST, raw HTTP, aliases, and WebSockets. If a ceiling is active for an operation classified `generate` and the estimator cannot produce a bound, return exit 5 before network with code `budget_estimate_unavailable`. This intentionally includes slot-priced voice-design operations until a defensible estimator exists. The error must say why and name the safe alternatives: remove the configured ceiling deliberately, use a smaller bounded input, or choose an operation with a documented estimator.

Unknown administrative/read costs do not turn `--max-credits` into a fictional global spend lock. Dry-run and live metadata report `budget_policy: unknown_unbounded` and `would_exceed_budget: null` when the operation can proceed but the ceiling cannot describe its cost. Documentation must say plainly that the ceiling is enforceable only where the CLI can compute a bound.

Do not fail closed for ordinary reads or free administrative mutations merely because their cost hint is `unknown`.

### C3. Review new risk and cost metadata

- `compose_detailed_stream`: `generate`, `per_generation`.
- `query_agent_knowledge_base_rag_route`: explicit `read` despite POST.
- `create_service_account`: `external_side_effect` via existing service-account policy.
- New Dubbing DELETE operations: `destructive` automatically.
- Dubbing create/language/regenerate operations: mark `generate` only where official billing semantics support it. Otherwise leave `mutate` plus `costHint: unknown`; do not invent a credit rate.

### C4. Tests

- Prove matched raw TTS inherits character estimation and budget blocking.
- Prove matched raw Music detailed streaming inherits SSE handling.
- Prove `/v1/dubbing/project` chooses the literal template over `/v1/dubbing/{dubbing_id}`.
- Prove unknown raw paths retain fallback behavior.
- Prove unknown generation estimates fail closed for explicit, environment, and profile ceilings.
- Prove RAG query reports `read` and remains ungated.

## Workstream D: SSE and new Music workflows

### D1. Add `sse_events`

Classify `text/event-stream` as `sse_events` rather than generic text. Parse SSE incrementally across arbitrary chunk boundaries:

- ignore comment lines;
- collect `event`, `id`, `retry`, and multiline `data` fields;
- treat blank lines as frame boundaries;
- preserve non-JSON data as strings;
- parse JSON data where valid;
- ignore a terminal `[DONE]` payload without losing the prior event;
- write one normalized event object per line to NDJSON.

When an event payload contains `audio_base64`, `audio`, or the documented Music audio-chunk field, decode and append it to a collision-safe audio file. Metadata and timestamps remain in NDJSON. No base64 audio may appear in the stdout envelope.

Malformed frames return a structured provider-stream error. If valid events or audio were already written, preserve those files, mark each `FileRecord` as `partial: true`, and explain that provider credits may already have been consumed. Discard only an output that is itself corrupt or empty.

### D2. Expand `music`

Add the one alias that closes a protocol/file ergonomics gap:

```text
elv music detailed-stream --prompt ... [--model music_v2] [--length-ms N] [--timestamps] [--format ...] --out DIR
```

It builds input and calls the generic runner. Detailed non-stream generation, composition plans, uploads, stems, and video-to-music remain fully supported through `elv call` plus runnable `ops schema --example` skeletons; duplicating those evolving schemas as aliases would add drift without improving file handling.

### D3. Tests

- Split every SSE delimiter across chunks in a mock response.
- Verify multiline data, JSON/non-JSON data, comments, IDs, retries, completion, and malformed trailing frames.
- Verify decoded audio bytes, metadata NDJSON, file hashes, and no stdout base64.
- Verify the detailed-stream alias resolves to the intended operation and dry-run input.

## Workstream E: current high-value REST workflows

### E1. Agent tests and RAG

Add:

```text
elv agents tests list
elv agents tests get --test-id ID
elv agents tests create --json|--json-file
elv agents tests update --test-id ID --json|--json-file
elv agents tests delete --test-id ID --yes
elv agents tests run --agent-id ID --json|--json-file
elv agents test-runs list
elv agents test-runs get --invocation-id ID
elv agents test-runs resubmit --invocation-id ID --json|--json-file
elv agents rag-query --agent-id ID --query TEXT [--branch-id ID]
```

Keep `agents simulate` for compatibility, but label it deprecated. Do not silently create persistent tests behind the old one-shot alias.

### E2. Workspace

Add:

```text
elv workspace members list
elv workspace service-accounts list
elv workspace service-accounts create --name NAME [--json|--json-file] --yes
```

The create response is secret-capable now, so it passes through the secret-result policy whenever credential-shaped fields are present.

### E3. Dubbing Project

Keep the current automatic-dubbing commands unchanged. Add only the transcript-editing helpers where positional IDs and segment bodies are materially easier than raw bucketed JSON:

```text
elv dubbing-project transcript get|add-segment|update-segment|delete-segment
elv dubbing-project target-transcript get|update-segment|regenerate
```

Use typed ID/file flags and `--json`/`--json-file` for evolving request bodies. Project/language CRUD remains discoverable and callable through `elv call`. Help must say this API is not a confirmed replacement for automatic Dubbing v2; official sources do not establish that migration.

### E4. Tests

- Unit-test every builder against its operation ID and bucketed input.
- Black-box test representative list/get/create/delete commands with a local mock server.
- Prove delete and service-account creation gates hold before network.
- Prove JSON and JSON-file conflicts fail at the command boundary.

## Workstream F: WebSocket coverage and safety

### F1. Make validation protocol-specific

Add a protocol field to each catalog entry. Keep the initial whitespace keep-alive requirement only for TTS protocols. Realtime STT, agent conversation, monitor, and raw targets must not inherit that rule.

Allow a receive-only script for monitoring. An empty NDJSON file is valid for protocols that do not require an initial client frame. TTS still requires its handshake.

Extend scripts with a bounded `send_binary_file` action so realtime STT can transmit audio without base64 inflation. Inbound binary frames go to collision-safe files rather than stdout. Keep JSON actions for TTS, agent conversation, and monitor controls. Catalog help must distinguish fully scriptable entries from catalog-only entries; no command may claim scripted support without a mock binary/JSON round trip.

### F2. Add enterprise conversation monitoring

Add `convai-monitor`:

```text
wss://api.elevenlabs.io/v1/convai/conversations/{conversation_id}/monitor
```

It requires `conversation_id`, profile API-key auth, and enterprise/workspace permissions. The catalog must say that it streams text/metadata only and that control events can end calls, transfer calls, inject context, or enable human takeover.

### F3. Add dry-run and confirmation

Forward common options into the WS runner. `--dry-run` resolves and redacts the URL, validates the script, reports protocol/risk, counts outbound actions, reports whether `--yes` is required, and never opens a socket.

Require `--yes` for:

- monitor `end_call`, `transfer_to_number`, `send_human_message`, contextual updates, and takeover controls;
- scripted agent-conversation messages that communicate outward;
- any future catalog entry marked external or destructive.

Listening to monitor events is read-only and ungated.

For TTS scripts, estimate characters from outbound text and apply the TTS model factor. If `--max-credits` is supplied for realtime STT or agent conversation and a defensible bound is unavailable, fail closed before connect. The dry-run envelope must expose the unknown estimate.

### F4. Preserve arbitrary WebSocket escape behavior

Raw `ws://` and `wss://` targets remain available and never receive the profile API key. Raw paths on the configured ElevenLabs host may use profile auth. Protocol validation for raw targets is limited to script validity and explicit safety classification; do not guess TTS rules or reject `eleven_v3` from an arbitrary URL unless the path matches a TTS catalog template.

### F5. Tests

- Prove TTS retains the keep-alive rule.
- Prove realtime STT accepts its own first event.
- Prove realtime STT sends exact binary file bytes and writes received binary frames to files.
- Prove monitor can run receive-only and sends profile auth only to the configured host.
- Prove monitor control without `--yes` never connects.
- Prove WS dry-run opens no socket and redacts tokens/URLs/scripts.
- Prove raw absolute targets never receive profile auth.
- Add opt-in live read-only smoke instructions for realtime STT and monitor; do not run enterprise or paid paths in CI.

## Workstream G: secret-result contract

### G1. Identify secret-producing responses

At minimum:

- `get_single_use_token`
- `get_livekit_token`
- `get_conversation_signed_link`
- `create_service_account`

Use a small curated operation set plus an exact credential-key set covering `token`, `signed_url`, `conversation_token`, `conversation_signature`, and documented LiveKit/WebRTC credential fields. Do not classify every field containing "token," because ordinary model metadata such as `token_cost_factor` is not a credential.

### G2. Spill secrets to restrictive files

For a successful secret-producing JSON response:

- never put the secret value in envelope `data`;
- write the unredacted response to a collision-safe file with mode `0600`;
- return a `FileRecord` with `sensitive: true`;
- return only key names/count in `data_summary`;
- include a warning that the file contains a short-lived credential;
- include a hint to read it only when needed and move it to Trash afterward.

Unify REST and WebSocket exact-key redaction so the same credential keys are protected on errors and non-curated paths. `--save-json` on a secret-producing response must also create or replace the destination at mode `0600`; it cannot preserve a weaker mode. `elv view` must not silently turn a secret file into redacted, unusable output: reject sensitive provider-response files with a hint to read the returned path directly, unless a future explicit reveal command is separately designed and confirmation-gated.

### G3. Tests

- Assert stdout/stderr never contain token, signed URL, or canary values.
- Assert file contents are complete and mode `0600`.
- Assert ordinary `token_cost_factor` and non-secret IDs remain visible.
- Assert matched `elv http` paths inherit the same secret-result policy.
- Assert `--save-json` cannot create or retain group/world permissions and `view` never reveals the credential.

## Workstream H: model and configuration honesty

### H1. Correct model wording

Describe `models list` as the account-visible response from `/v1/models`, not an exhaustive product catalog. Document the official cross-product IDs and deprecations in README/AGENTS without turning them into a local allowlist.

### H2. Stale-enum remediation

When Ajv rejects only a model enum value, add a targeted hint:

```text
elv spec status
elv spec diff
elv spec update
```

Keep `--allow-unknown` for unknown body keys; do not use it to bypass a known enum silently. Agents can use `elv http` deliberately when a just-launched model precedes the public spec.

### H3. Resolve `default_model_id`

Apply `default_model_id` only to TTS aliases and TTS WebSocket catalog entries when the user does not pass a model. Do not apply one global default to STT, Music, SFX, or voice conversion. Rename the exposed resolved field/documentation to make that scope clear while preserving config backward compatibility.

While plumbing resolved configuration through runners, ensure standalone `wait` honors the selected profile's base URL and the same explicit/env/profile precedence. This closes the existing polling mismatch without adding a new command surface.

### H4. Tests

- Prove explicit model always wins.
- Prove TTS profile default is applied when absent.
- Prove other modalities do not inherit the TTS default.
- Prove stale model enum errors include spec-refresh guidance.

## Workstream I: documentation and claims

Update README, AGENTS, the shipped `elv` skill, CHANGELOG, and setup docs to say:

- 339 documented / 338 callable operations at the pinned snapshot;
- `call` is the complete current REST surface and `http` is the forward-compatibility escape hatch;
- `models list` is account-visible, not exhaustive;
- Music detailed SSE emits NDJSON plus audio;
- agent simulation is deprecated and agent tests are preferred;
- Dubbing Project editing is distinct from automatic Dubbing v2;
- the supported WebSocket catalog and Speech Engine upstream exclusion;
- secret results are file-only and `0600`;
- what `--max-credits` can estimate and when it fails closed;
- UI-only ElevenCreative products are outside the public API contract.

Static operation counts must be pinned by a test or generated from snapshot metadata so they cannot drift independently.

## Implementation sequence and dependency graph

### Checkpoint 1: research and plan

Files:

- `docs/research/*.md`
- this plan
- external Claude and Grok review artifacts
- `model-performance-journal.md`

Gate: plan incorporates both external reviews and has no unresolved structural contradiction.

### Wave 1: contract and metadata

Tasks:

- A1-A4: snapshot, metadata, transactional refresh, status/diff.
- C3: risk/cost/deprecation metadata needed by downstream work.
- B2-B3 core operation inventory and deprecation fields.

Dependencies: none beyond the plan.
Unblocks: every later workstream.

Checkpoint commit: `feat(spec): refresh and audit the full ElevenLabs API contract`.

### Wave 2: transport correctness

Tasks:

- C1-C2: raw HTTP inheritance and budget fail-closed behavior.
- D1: SSE parser and normalized files.
- G1-G3: secret-result policy.

Dependencies: Wave 1 operation metadata.
Unblocks: Music aliases, secure token workflows, honest escape-hatch claims.

Checkpoint commit: `feat(core): harden streaming budgets and secret outputs`.

### Wave 3: curated workflows

Tasks:

- D2-D3: Music.
- E1-E4: Agents, Workspace, Dubbing Project.
- H2-H4: model default and remediation behavior.

Dependencies: Waves 1-2.
Unblocks: final discovery and docs.

Checkpoint commit: `feat(cli): add current Music Agents Workspace and Dubbing workflows`.

### Wave 4: WebSockets and self-documentation

Tasks:

- F1-F5: protocol-specific WS behavior, monitor, dry-run, confirmation, budget.
- B1/B4: capabilities contract.
- H1 and I: docs and claims.

Dependencies: metadata, budget, secret, and alias inventories.
Unblocks: final validation.

Checkpoint commit: `feat(cli): complete realtime coverage and agent discovery`.

### Final validation

Run, in order:

```bash
npm run format
npm run typecheck
npm run lint
npm run format:check
npm run test
npm run build
git diff --check
```

Then invoke the built binary for:

- bare help and `capabilities` JSON parsing;
- `ops list` filters and valid empty results;
- `spec status`, `spec diff --offline`, and `spec update --offline --dry-run`;
- schemas/examples for all 19 new operations;
- dry-runs for every new alias;
- refusal paths for Dubbing deletes, workspace service-account creation, monitor controls, and unknown generation budgets;
- a mock SSE stream and all mock WebSocket protocols;
- live read-only `models list`, `voices list`, and representative new GET operations when the account has permission.

Do not send a paid generation, create a service account, edit a dub, control a conversation, or push a branch.

## Native-subagent execution map

The coordinator owns `src/cli.ts`, shared types, alias registration, final merges, tests, commits, and every gate. Native implementation lanes get disjoint file ownership:

1. **Spec lane:** `src/openapi/fetch-spec.ts`, `src/openapi/registry.ts`, `src/commands/spec.ts`, snapshot metadata, and spec tests.
2. **Core lane:** HTTP inheritance, risk/budget, response normalization/SSE, secret file behavior, and their tests. Split into serial sub-waves where files overlap.
3. **Alias lane:** one owner for all files under `src/commands/aliases/` plus alias tests, avoiding concurrent edits to `aliases/index.ts`.
4. **WebSocket lane:** `src/ws/`, `src/commands/ws.ts`, and WS tests.
5. **Discovery/docs lane:** `src/commands/ops.ts`, capabilities implementation, docs, and command-contract tests; coordinator wires CLI registration.

Workers do not run the full gate in parallel. They run only narrow tests for owned files and report changed paths. The coordinator runs the canonical gate once per integrated wave.

## Five review/fix rounds after implementation

Each round uses a fresh read-only delegated reviewer against the current working tree. The coordinator verifies every finding in source, fixes confirmed issues, runs the narrowest relevant tests, commits the round when it changes code, and journals the model result.

1. **Claude, architecture and API fidelity:** compare implementation to this plan and research; find omissions, false coverage claims, and needless complexity.
2. **Grok, security and trust boundaries:** secrets, auth routing, destructive/outbound gates, budget fail-closed behavior, raw escape hatches, path matching, and temp-file permissions.
3. **Claude, streaming and protocol correctness:** SSE chunking, audio extraction, WebSocket handshakes, timeouts, receive-only sessions, retries, cleanup, and partial-failure behavior.
4. **Grok, agent ergonomics and compatibility:** first-try commands, errors/hints, deprecations, deterministic output, bounded results, old aliases/configs, and docs accuracy.
5. **Claude, final diff and regression review:** inspect the full branch diff, tests, package contents, generated artifacts, and any residual mismatch between claims and proof.

A round is complete only after confirmed findings are fixed or rejected with evidence. "No findings" is acceptable; skipping the reviewer is not.

## Acceptance criteria

The work is done when all of these are true:

- The snapshot at the recorded SHA compiles to 338 callable operations and includes every published OpenAPI operation at that point except the deliberate compiler skip.
- `elv capabilities`, `ops list`, `spec status`, and `spec diff` are stable one-envelope machine contracts.
- Spec refresh is compile-first, dry-runnable, provenance-aware, and atomic.
- Every new operation is discoverable offline; risk, cost, stream, and deprecation metadata have been deliberately reviewed.
- Raw HTTP inherits matched operation semantics.
- Music detailed SSE produces useful metadata and audio files.
- Current agent tests/RAG, workspace, Music detailed streaming, and Dubbing Project transcript edits have thin aliases over the common runner; every other new operation is covered through `call`.
- Deprecated simulation stays compatible but cannot be mistaken for the preferred path.
- TTS, multi-context TTS, realtime STT, agent conversation, and conversation monitor are discoverable with protocol-specific WS validation; STT binary scripting is proven with exact-byte mock tests.
- WebSocket dry-run and confirmation gates are proven not to connect.
- Secret-producing responses are usable through `0600` files and absent from stdout/stderr.
- Current model guidance is accurate without a brittle local allowlist.
- Existing aliases remain compatible unless a documented deprecation warning is added.
- All tests, typecheck, lint, formatting, build, binary smoke tests, and five review/fix rounds pass.
- The current branch contains local checkpoint commits and `git status` is clean.
- No remote push occurred.

## Known residual limits

- Credit estimation will remain unknown for some provider operations until ElevenLabs publishes enough billing inputs.
- The CLI states that uncertainty rather than representing `--max-credits` as a provider-wide spend lock.
- Enterprise and beta endpoints may be discoverable but unavailable to the test account.
- UI-only ElevenCreative products remain outside the public API until official contracts exist.
- Live model availability can differ by account and rollout.
- A point-in-time vendored snapshot will eventually drift again; the new diff/status workflow makes that drift visible and safe to update.
