# Weekly ElevenLabs API parity plan

- **Date:** 2026-08-10
- **Branch:** `automation/api-sync/2026-08-10` from local `main` at `b99d0e5`
- **Open predecessor:** [PR #3](https://github.com/treygoff24/elv/pull/3) at `0b7a351`
- **Vendor contract:** ElevenLabs OpenAPI 3.1.0, `info.version` `1.0`, retrieved
  2026-08-11T14:43:48Z (plan date retained from the initial August 10 audit)
- **Vendor SHA-256:**
  `d1a4847203cef628b0c43760b0c74ecd88fa280034bb47c973874ae911f6153a`

## Decision

Ship one replacement parity PR that:

1. reuses the already reviewed July 27 parity commits instead of reimplementing
   their Music Finetunes, crawl-job, STT, bulk knowledge-base, pagination, CSV,
   and safety work;
2. advances the vendored OpenAPI contract from July 16 to August 11;
3. exposes the newly documented Agents Procedures family, Dubbing v2 bulk
   transcript edits, voice accents, voice replication, and new voice-list
   filters through the existing alias families;
4. classifies cross-residency voice replication at the shared registry seam as
   an external side effect requiring `--yes`;
5. documents current realtime STT entity detection and the Dubbing v2 boundary
   without adding a new transport or dependency.

The generic `ops` / `call` / `http` surface remains the completeness mechanism.
Aliases are added only where ElevenLabs now publishes a stable, coherent family
or changed a high-use existing alias.

## Primary evidence

The OpenAPI artifact was re-retrieved on 2026-08-11; the supporting official
documentation sources were retrieved on 2026-08-10.

- [Official live OpenAPI](https://api.elevenlabs.io/openapi.json): 285 paths,
  364 documented operations, 363 callable operations, one source-skipped route,
  1,402 schemas, SHA-256 above.
- [Official documentation index](https://elevenlabs.io/docs/llms.txt): lists all
  eight Agents Procedures references, voice accents, and isolated-environment
  voice replication.
- [Official August 3 changelog](https://elevenlabs.io/docs/changelog/2026/8/3):
  documents voice replication, Agents procedure/configuration changes,
  conversation version filters, realtime STT entity detection, and breaking
  schema changes including `CharacterAge` and removed `audio_filter`.
- [Official Dubbing v2 release](https://elevenlabs.io/blog/dubbing-api), published
  2026-08-06: confirms the single-request automatic pipeline plus enterprise
  source/target transcript editing and changed-segment regeneration.
- [Official Procedures API reference](https://elevenlabs.io/docs/api-reference/agents/procedures/list):
  stable resource family rooted at an agent branch.
- [Official voice replication reference](https://elevenlabs.io/docs/api-reference/voices/replicate-to-isolated-environment):
  cross-residency copy within one consolidated billing group, central environment
  only, with source and target workspace permissions.

Context7 was queried first using `/websites/elevenlabs_io`. Exa provided the
official changelog, API-reference discovery, and source excerpts. Firecrawl was
used only when Exa's stale developer-blog URL returned a 404; it resolved and
scraped the canonical `/blog/dubbing-api` page.

## Reproducible drift

| Measure               | Checked-out July 16 | Open PR July 27 | Live August 11 |
| --------------------- | ------------------: | --------------: | -------------: |
| Paths                 |                 268 |             277 |            285 |
| Documented operations |                 339 |             352 |            364 |
| Callable operations   |                 338 |             351 |            363 |
| Skipped operations    |                   1 |               1 |              1 |
| Schemas               |               1,345 |           1,372 |          1,402 |
| SHA-256               |       `de047661...` |   `494d9641...` |  `d1a48472...` |

The checked-out branch is missing all 25 operations added since July 16. PR #3
already implements and validates the first 13 additions. The August 11 artifact
adds these 12 over the PR #3 contract:

| Family            | Operation IDs                                                                                                                                                                                                               | Method/path summary                                                                     | Disposition                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Agents Procedures | `list_procedures_route`, `create_procedure_route`, `get_procedure_route`, `remove_procedure_route`, `get_procedure_draft_route`, `update_procedure_draft_route`, `delete_procedure_draft_route`, `compile_procedures_route` | CRUD/draft/compile below `/v1/convai/agents/{agent_id}/branches/{branch_id}/procedures` | Generic + `agents procedures` aliases             |
| Dubbing v2        | `dubbing_transcript_segments_update`, `dubbing_target_transcript_segments_update`                                                                                                                                           | Atomic enterprise bulk source/target segment PATCH                                      | Generic + existing `dubbing-project` aliases      |
| Voices            | `get_voice_accents`                                                                                                                                                                                                         | Read available accents, optionally by language/model                                    | Generic + `voices accents` alias                  |
| Voices            | `replicate_voice_to_isolated_environment`                                                                                                                                                                                   | Cross-residency POST into another workspace                                             | Generic + `voices replicate`; shared `--yes` gate |

No operation was removed or newly deprecated. Seventeen same-ID operations
changed since July 27. Material input/output deltas are:

- conversations add `version_id`, `parent_conversation_id`, and guardrail
  filters; message search adds `version_id`;
- branch listing adds `include_commit_status`;
- voice listing adds gender, age, language, accent, use-case, notice-period,
  custom-rate, live-moderation, and quality filters;
- Dubbing regeneration now returns `DubbingRegenerateResponse`, and the Dubbing
  project schemas carry v2 changes;
- `video_to_music` now explicitly declares an `application/zip` binary response;
- production order status now references `OrderState`;
- the August 3 changelog records `CharacterAge`'s breaking
  `middle-aged` -> `middle_aged` migration and removal of Agents TTS
  `audio_filter`.

The live document also adds 79 schemas, removes 23, and changes 125 relative to
the checked-out July 16 document. Compilation against the current code succeeds
at all 363 callable operations.

## Capability matrix

Counts are live OpenAPI tag memberships and may overlap. "Generic" means
validated `elv call` coverage plus `http` for ahead-of-snapshot REST.

| Official family                                | Live evidence                                            | Current CLI                             | Weekly disposition                                                 |
| ---------------------------------------------- | -------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------ |
| Voices, cloning, PVC, samples                  | 23 voices, 14 PVC, 2 sample memberships                  | Generic + `voices`                      | Refresh; add accents, replication, and list filters                |
| Text to Speech / dialogue                      | 8 operations                                             | Generic + `tts` + TTS WS                | Covered; refresh schemas and removed `audio_filter`                |
| Speech to Speech                               | 2 operations                                             | Generic + `voice-change`                | Covered                                                            |
| Audio isolation                                | 4 operations                                             | Generic + `voice-isolate`               | Covered                                                            |
| Dubbing v2 / Dubbing Project                   | 17 Dubbing Project plus 47 compatibility-tag memberships | Generic + `dubbing` + `dubbing-project` | Add atomic source/target segment aliases; refresh v2 schemas       |
| ElevenAgents / conversations                   | 147 Agents Platform memberships                          | Generic + `agents` + agent/monitor WS   | Add Procedures aliases; refresh filters/config schemas             |
| Knowledge bases / tools / integrations         | Agents Platform, crawl, MCP, secrets, tools              | Generic + `agents rag-query`            | Integrate PR #3 crawl/bulk safety work                             |
| Studio / projects / productions / Audio Native | 23 Studio, 11 Productions, 4 Audio Native                | Generic                                 | Covered; refresh changed order schema                              |
| Pronunciation dictionaries                     | 9 operations                                             | Generic                                 | Covered                                                            |
| Sound effects                                  | 1 operation                                              | Generic + `sfx`                         | Covered                                                            |
| Music / Finetunes / video-to-music             | 7 generation, 5 Finetunes, 1 video                       | Generic + `music`                       | Integrate PR #3 Finetunes; refresh ZIP metadata                    |
| Speech to Text / transcription                 | 3 REST + realtime WS                                     | Generic + `stt` + named WS              | Integrate PR #3 webhook/token fix; document entity detection query |
| History                                        | 5 operations                                             | Generic + `history`                     | Covered                                                            |
| Usage / models / analytics                     | model, subscription, usage, analytics routes             | Generic + `usage` + `models`            | Covered                                                            |
| Webhooks / events                              | workspace CRUD plus event schemas                        | Generic                                 | Covered outbound API; receiver remains out of scope                |
| Workspaces / admin                             | 29 workspace memberships plus enterprise routes          | Generic + `workspace`                   | Covered; replication safety spans workspaces                       |
| Batch / async / streaming                      | Batch calls, crawl, tests, dubbing, SSE, REST, WS        | Generic + `wait` + stream normalizers   | Integrate PR #3 CSV/pagination; refresh Dubbing response           |
| Files / media                                  | Multipart uploads and binary/audio/ZIP/CSV responses     | Generic file handling                   | Refresh metadata; no new media abstraction                         |
| Beta / new surfaces                            | Published OpenAPI and official WS docs                   | `call`, `http`, `ws`                    | No private endpoint reverse engineering                            |

## Confirmed gaps and root-cause changes

### 1. Reuse the open July 27 implementation

Cherry-pick `c7b89c3` and `0b7a351` onto this feature branch. These commits have
green macOS and Ubuntu CI and already carry the reviewed July 16 -> July 27 work:

- Music Finetunes lifecycle aliases and generation `finetune_id`;
- correct STT webhook ID and environment-sourced token behavior;
- crawl cancellation and bulk knowledge-base risk curation;
- POST-body-safe pagination and valid required-array examples;
- binary CSV spill handling and Node 22 multipart retry portability;
- docs, provenance tests, pack smoke, and coverage assertions.

The parity commits' vendor behavior is authoritative for STT webhook IDs and
environment tokens, Music Finetunes, crawl/bulk safety, pagination, required
examples, CSV persistence, and multipart retry tests. Preserve current `main`'s
newer shared implementation only where it does not undo those semantics. The
vendored snapshot and metadata must resolve to August 11, not PR #3's July 27
artifact. Do not copy a conflicted source file wholesale.

### 2. Refresh the vendored contract and provenance

Replace `spec/openapi.snapshot.json`, update
`spec/openapi.snapshot.meta.json`, and advance counts/hash/date in:

- `README.md`
- `AGENTS.md`
- `skills/elv/SKILL.md`
- `docs/agent-setup.md`
- `docs/api-coverage.md`
- `CHANGELOG.md`
- `src/commands/capabilities.ts`

First re-run live fetch and compilation after the PR #3 integration; the
authoritative re-fetch at `/tmp/elv-openapi-latest.json` compiled at 363 callable
operations, but the integrated tree is the release authority.
Update `tests/openapi/openapi-update-spec.test.ts` from 338 to 363 and keep both
364 and 363 as standalone counts in every file enforced by
`tests/openapi/docs-coverage-counts.test.ts`. Assert all 12 August operations
compile, new schemas remain usable through `ops schema --example`, Dubbing
regeneration uses its new response, and `video_to_music` remains binary.

### 3. Add Agents Procedures aliases at the existing shared seam

Extend `src/commands/aliases/agents.ts` with one `agents procedures` group:

```text
list | create | get | remove | get-draft | update-draft | delete-draft | compile
```

Reuse `runAlias`, `runListAlias`, `readJsonBody`, and existing required-flag
helpers. Require `--agent-id` and `--branch-id`; require `--procedure-id` only
where the OpenAPI path does. Accept `--version-id` on `get`. Use `--json` or
`--json-file` for create/update bodies. The live spec confirms
`remove_procedure_route` and `delete_procedure_draft_route` are DELETEs, so both
inherit the registry's destructive `--yes` rule; assert the alias refusal and do
not add redundant alias-local safety code.

Add all eight procedure IDs to the sorted `agents` entry in
`src/commands/capabilities.ts`, extend the registry-existence list in
`tests/commands/api-expansion-aliases.test.ts`, and add focused
builder/help/refusal tests. Add `0 agents procedures` to the offline smoke
matrix. Do not invent procedure configuration types outside the OpenAPI schema.

### 4. Extend existing voice and Dubbing aliases

In `voices`:

- add `accents` with optional `--language` and `--model-id`;
- add `replicate` with `--voice-id`, `--target-workspace-id`, and
  `--no-preserve-voice-id` or JSON input;
- map the new list filters exactly: `--gender`, `--age`, variadic `--language`,
  `--accent`, variadic `--use-case`, `--min-notice-period-days`,
  `--no-custom-rates`, `--no-live-moderated`, and `--high-quality`. Generic
  `call` remains available for future or uncommon query fields.

In `dubbing-project`:

- add `transcript update-segments`;
- add `target-transcript update-segments`.

Both Dubbing commands reuse the existing JSON body and project/language path
helpers. Update the parent description so it no longer says Dubbing Project is
distinct from Dubbing v2. Add both Dubbing IDs and both voice IDs to their
sorted `ALIAS_FAMILIES` entries and to the alias registry-existence test. Do not
add another Dubbing namespace or transport.

### 5. Gate cross-residency voice replication centrally

Add `replicate_voice_to_isolated_environment` to the curated external-side-effect
set in `src/openapi/risk.ts`. This single registry classification applies to
`call`, matching `http`, aliases, dry-run previews, `ops get`, and confirmation
checks. Extend risk and confirmation-contract tests so the operation:

- compiles as `external_side_effect`;
- with no credit ceiling, exits 4 before network access without `--yes`;
- with `ELV_MAX_CREDITS` or `--max-credits`, first follows the existing
  unknown-unbounded budget-consent path (exit 5) and still requires `--yes`;
- reports `would_require_yes: true` during a network-free dry run.

The endpoint copies a voice across data residencies and workspace boundaries;
plain `mutate` would understate its blast radius.

### 6. Preserve the agent-facing protocol

Keep one `v:1` envelope on stdout, no prompts, stable exit codes, file-only large
or binary results, and redacted auth. Update `docs/api-coverage.md` for realtime
STT `entity_detection` and Dubbing v2, and remove Music Finetunes and published
transcript editing from the deliberate-exclusion text. The named STT WebSocket
already forwards arbitrary `--query key=value` parameters, so no protocol code
is needed.

The inherited `format:check` failure in `src/core/duration.ts` must be normalized
with the repo's formatter. Limit formatting changes to files the formatter
reports (currently only `src/core/duration.ts`); no behavioral change is
intended.

### 7. Close verification and budget-policy gaps found during release review

An active JSON registry cache omits undefined operation-card fields. The
pre-existing canonical comparison retained those fields, so an identical live
spec could falsely report every cached operation as changed. Normalize the
comparison at the shared `canonical()` seam to match JSON serialization and add
an active-cache round-trip regression; do not special-case individual fields.

The current OpenAPI description says `dubbing_target_transcript_regenerate` is
charged like a generation. Classify it in the existing generation set without
inventing a cost hint. With a configured ceiling and no defensible estimate,
the alias, generic `call`, and matching raw `http` must fail closed with exit 5
before any network request, even when `--yes` is present.

## Compatibility and migration risk

- REST coverage rises from 338 to 363 callable operations on the checked-out
  branch; no operation disappears.
- Existing aliases and envelope shapes stay intact. Added subcommands and flags
  are additive.
- Voice replication now exits 4 without `--yes`; this is an intentional safety
  tightening for a newly exposed cross-workspace operation.
- Dubbing target-transcript regeneration now follows the generation budget
  policy; a configured ceiling fails closed when no estimate is available.
- July 27 integration carries its documented STT migration: a literal webhook
  URL is rejected in favor of a configured webhook ID, and a single-use token
  comes from an environment variable rather than argv. Preserve focused tests
  for URL refusal, webhook-ID body placement, environment-token transport, and
  absence of argv secrets, plus the changelog and shipped skill migration note.
- `CharacterAge=middle-aged` is no longer valid in the vendor schema; generated
  schema/examples expose `middle_aged`.
- Dubbing regeneration and video-to-music response metadata change with the
  vendor contract; the file-only response invariant remains stable.
- No new dependency, envelope version, exit-code dictionary, or config format.

## Validation and live-smoke plan

Inherited baseline: `npm run gate` currently stops at `format:check` on
`src/core/duration.ts`; no task changes existed when observed. Dependencies were
then installed with `npm ci`.

After implementation:

1. run focused alias, STT migration, OpenAPI, risk, confirmation, response,
   pagination, and WS tests for every changed surface;
2. run `npm run gate`;
3. run `npm run smoke:pack`;
4. rebuild and verify the installed runtime with `elv --version` and
   `ELV_BIN="$(command -v elv)" npm run smoke`;
5. verify `ops get` and `ops schema --example` for all 12 new operations;
6. run offline dry-run previews for Dubbing bulk updates and refusal probes for
   procedure deletion and voice replication, including matching raw-HTTP
   metadata and the replication budget-ceiling branch;
7. if existing auth is present, run only read-only authenticated smokes: models,
   usage, voices, voice accents, Music Finetunes list, crawl jobs list, and an
   Agents Procedures list only if a safe existing agent/branch can be discovered;
8. do not replicate a voice, mutate or compile procedures, edit Dubbing
   transcripts, delete knowledge-base data, start/cancel jobs, generate media,
   export recipient data, or perform outbound/admin mutations;
9. inspect stdout/stderr and written artifacts for secret leakage.

## Review workflow

Before implementation, run this plan through the same bounded read-only brief in
parallel on Delegate Claude and Delegate Cursor/Grok 4.5. Adjudicate and patch the
plan.

After implementation and green local checks, run three read-only full-diff
reviews in parallel: Cursor/Grok 4.5, Claude, and Codex Sol xhigh. Fix every
actionable finding with native Codex subagents, rerun focused and full checks,
then run a fresh final Codex Sol xhigh review on the post-fix diff. All Delegate
invocations are journaled privately in `~/.delegate/model-journals/`.

## Rollback

Revert the parity commit(s). The previous vendored snapshot remains in Git, and
registry fingerprints force cache recompilation when the bundled spec or risk
curation changes. The validation plan performs no provider mutation, so rollback
requires no remote cleanup.

## Non-goals and residual boundaries

- No private ElevenCreative, UI-only, Reception.ai, or reverse-engineered route.
- No inbound webhook server; the CLI manages published webhook resources only.
- No Speech Engine upstream client: ElevenLabs connects to a customer-hosted
  server, while its REST resource configuration remains generically callable.
- No custom SDK mirror or handwritten response-model layer; OpenAPI remains the
  source of truth.
- No paid generation, outbound call/message, deletion, cross-residency copy,
  procedure compile, Dubbing edit, or admin mutation live smoke.
- Four high-severity issues reported by `npm audit` after `npm ci` are inherited
  dependency state and outside this API-parity change unless a changed dependency
  or reviewer evidence ties them to the shipped runtime.
