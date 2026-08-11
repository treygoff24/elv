# Weekly ElevenLabs API parity plan

**Date:** 2026-07-23
**Branch:** `automation/api-sync/2026-07-23` from `origin/main`
**Vendor contract:** ElevenLabs OpenAPI `info.version` `1.0`, retrieved 2026-07-23 at 20:58:58Z
**Vendor SHA-256:** `d79f40a567cadc1e9c6933dca59cc8c80e2655490008c43758ad1c6fe0290e4f`

## Decision

Refresh the vendored contract and add only the thin workflows where the July 20 API changes make the current alias misleading or materially harder to use. Keep `elv call` as the complete REST surface instead of duplicating the OpenAPI registry in handwritten commands.

The smallest coherent patch is:

1. pin the current 349-operation OpenAPI document;
2. expose Music Finetunes under the existing `music` noun and pass `finetune_id` through every Music generation alias;
3. repair the stale STT webhook alias and expose single-use Scribe tokens without putting credentials in argv;
4. classify crawl cancellation as destructive because the provider says it deletes associated documents and folders;
5. update the checked-in coverage contract and focused tests.

## Primary evidence

Retrieved on 2026-07-23:

- [Official live OpenAPI](https://api.elevenlabs.io/openapi.json): 274 paths, 349 documented operations, 348 callable operations, one source-skipped deprecated route, 1,367 schemas, SHA-256 above.
- [Official July 20 changelog](https://elevenlabs.io/docs/changelog/2026/7/20.md): Music Finetunes, conversation-reference resolution, STT single-use tokens, changed STT/webhook/dictionary/workspace fields, and schema/default changes.
- [Official Music Finetunes guide](https://elevenlabs.io/docs/eleven-creative/products/music/finetunes.md): upload limits, training behavior, copyright constraints, and the current enterprise/API caveat.
- [Official Music Finetunes create reference](https://elevenlabs.io/docs/api-reference/music/finetunes/create): multipart create contract, up to 50 files, required name and primary genre.
- [Official STT convert reference](https://elevenlabs.io/docs/api-reference/speech-to-text/convert): boolean webhook delivery, optional webhook ID, and single-use `token` query authentication.

Context7 was queried first using `/websites/elevenlabs_io` and corroborated the current API-reference surface. Exa search was attempted but was unavailable because the configured account had no remaining credits; the audit therefore used direct official vendor artifacts only.

### Reproducible drift

| Measure | Vendored July 16 | Live July 23 | Delta |
| --- | ---: | ---: | ---: |
| Paths | 268 | 274 | +6 |
| Documented operations | 339 | 349 | +10 |
| Callable operations | 338 | 348 | +10 |
| Schemas | 1,345 | 1,367 | +22 net |

Added operations:

- `resolve_conversation_reference_route`
- `create_crawl_job_route`
- `list_crawl_jobs_route`
- `get_crawl_job_route`
- `cancel_crawl_job_route`
- `get_finetunes`
- `create_finetune`
- `get_finetune`
- `update_finetune`
- `delete_finetune`

Changed operations:

- `get_user_voices_v2`
- `speech_to_text`
- `get_agent_response_tests_summaries_route`
- `get_conversation_histories_route`
- `text_search_conversation_messages_route`

No operations were removed or newly deprecated. The CLI's own `spec diff` compiled all 348 callable operations and reported 42 changed same-name schemas.

## Capability matrix

Counts overlap where an operation belongs to more than one workflow family. "Generic" means validated `elv call` coverage plus `http` for ahead-of-snapshot REST; aliases are convenience, not the completeness mechanism.

| Official family | Live inventory | Existing CLI path | Weekly disposition |
| --- | --- | --- | --- |
| Voices / cloning / PVC | 26 matching operations | Generic + `voices` | Covered; refresh fields and enums through spec |
| Text to Speech / dialogue | 8 | Generic + `tts` + realtime WS | Covered; refresh schemas/defaults |
| Speech to Speech | 2 | Generic + `voice-change` | Covered |
| Audio isolation | 4 | Generic + `voice-isolate` | Covered |
| Dubbing / Dubbing Projects | 35 | Generic + `dubbing` + `dubbing-project` | Covered |
| ElevenAgents / conversations | 155 | Generic + `agents` + `convai`/monitor WS | Add new REST IDs through spec; no one-off alias for reference resolution |
| Knowledge bases / tools / integrations | 61 | Generic + RAG alias | Add crawl jobs through spec; fix destructive cancellation gate |
| Studio / projects / productions | 34 | Generic | Covered; aliases would duplicate stable discovery |
| Pronunciation dictionaries | 10 | Generic | Refresh `include_archived`; no new alias |
| Sound effects | 1 | Generic + `sfx` | Covered |
| Music | 13 | Generic + `music` | Add Finetunes lifecycle and generation `finetune_id` aliases |
| Speech to Text / transcription | Public REST + realtime WS | Generic + `stt` + realtime WS | Repair webhook semantics; add env-sourced single-use token |
| History | 7 | Generic + `history` | Covered |
| Usage / models | 6 | Generic + `usage` + `models` | Refresh analytics enums |
| Webhooks / events | 4 workspace CRUD routes plus event schemas | Generic | Refresh subscription fields; no receiver server in this CLI |
| Workspaces / admin | 32 | Generic + `workspace` | Refresh webhook/service-account schemas |
| Batch / async | 12 | Generic + `wait` | Add crawl jobs through spec; polling primitive already exists |
| Files / media | 28 | Generic multipart/binary handling | Existing repeatable `--file field[]=path` supports Finetune uploads |
| Beta / newly published | Included when present in official OpenAPI | `call`, `http`, `ws` | No private endpoint reverse engineering |

## Plan-review disposition

Two independent read-only reviewers returned **approve with revisions**. Both confirmed the schema-driven architecture, shared destructive-risk fix, and secret-safe token direction. This revision accepts their actionable findings:

- name every cross-cutting contract and test file;
- use `runListAlias`, `addPaginationFlags`, and the existing `collect` helper rather than parallel plumbing;
- specify exact STT body/query and validation behavior;
- pin the new `token` query parameter and crawl risk in tests;
- place `finetune_id` in the JSON body for all three Music generation operations, matching the live schemas.

## Confirmed gaps and root-cause changes

### 1. Vendored contract drift

Replace `spec/openapi.snapshot.json`, update `spec/openapi.snapshot.meta.json`, and update the shipped contract in:

- `README.md`
- `AGENTS.md`
- `skills/elv/SKILL.md`
- `docs/agent-setup.md`
- `docs/api-coverage.md`
- `CHANGELOG.md`
- `src/commands/capabilities.ts`

Extend `tests/openapi/openapi-compile.test.ts` with all ten additions, assert `create_finetune` retains its array-binary `files` field, and assert `speech_to_text` exposes the `token` query parameter. Update `tests/openapi/openapi-update-spec.test.ts` and `tests/openapi/docs-coverage-counts.test.ts` for the new provenance and counts. The capabilities contract must list all five Finetune operation IDs under the existing Music family.

This is a data refresh, not a generator rewrite: the current compiler already proves it can compile the live document.

### 2. Music Finetunes agent ergonomics

Extend `src/commands/aliases/music.ts` rather than create another command family:

```text
elv music finetunes list [filters/pagination]
elv music finetunes get --finetune-id ID
elv music finetunes create --name NAME --primary-genre GENRE --file PATH...
elv music finetunes update --finetune-id ID --json|--json-file
elv music finetunes delete --finetune-id ID --yes
```

Creation uses the existing repeatable multipart file contract and accepts optional tags, visibility, and model. Update keeps an evolving JSON body rather than duplicating every optional field. Every existing Music generation form gains `--finetune-id`.

Implementation reuses existing seams:

- `finetunes list` uses `addPaginationFlags` and `runListAlias`;
- `finetunes create` uses Commander's existing `collect` helper for repeatable `--file`, producing `files: { files: string[] }`;
- `finetunes update` uses `readJsonBody`;
- CRUD commands continue through `runAlias`;
- `finetune_id` is placed in `body` for `generate`, `stream_compose`, and `compose_detailed_stream`, exactly as all three live schemas specify.

Document that upload ownership/copyright rules and provider charges still apply; the CLI does not decide whether an account is entitled to the API.

### 3. STT webhook and token semantics

The current alias sends a URL string in the boolean `webhook` body field. That invocation cannot validate even against the vendored July 16 schema, which already contains boolean `webhook` and nullable `webhook_id`; this is a pre-existing alias defect exposed during the weekly field audit, not new July 20 behavior.

Change the canonical surface to:

```text
elv stt --file AUDIO --webhook [--webhook-id ID]
elv stt --file AUDIO --token-env ENV_NAME
```

`--webhook-id` requires `--webhook`. Keep `--webhook [legacy_url]` as an optional-argument compatibility parser: a supplied URL fails locally with a precise migration message instead of silently changing meaning. `--token-env` reads the one-time token from the named environment variable so the credential never appears in argv; dry-run/debug redaction already recognizes the `token` query key.

Exact builder behavior:

- bare `--webhook` writes `body.webhook: true`;
- `--webhook-id ID` writes `body.webhook_id: ID` and fails validation unless bare `--webhook` is also present;
- `--webhook URL` fails with exit 2 and tells the agent to configure a workspace webhook, then use `--webhook [--webhook-id ID]`;
- `--token-env NAME` reads `process.env[NAME]`, fails with exit 2 when unset or empty, and writes the value only to `query.token`;
- no token value appears in help text, argv, error details, dry-run output, debug output, or committed fixtures.

Rewrite the pinned webhook golden in `tests/commands/aliases.test.ts` and add focused validation/redaction coverage for the migration error and missing token environment.

### 4. Crawl cancellation safety

Add `cancel_crawl_job_route` to the curated destructive set. The live description says the POST cancels the job **and deletes all associated documents and folders**; it must require `--yes` through both `call` and matching raw `http`. Add the exact POST-to-destructive assertion in `tests/openapi/openapi-risk.test.ts` and a short source comment distinguishing this route from ordinary `cancel_batch_call`, which is an external side effect but does not delete knowledge-base content.

## Compatibility and migration risk

- Snapshot refresh is additive: ten operations added, none removed.
- Changed request fields/defaults come from the authoritative vendor schema. The generic runner remains schema-driven.
- `stt --webhook <url>` never matched the provider's current request type. Preserve its parse shape only to return an actionable migration error; `stt --webhook` becomes the working form.
- The new crawl cancellation gate changes a previously ungated POST to exit 4 without `--yes`. This is intentional safety tightening.
- Music Finetunes may be account- or enterprise-gated despite being in public OpenAPI. Provider 403/404 responses remain normalized provider/auth errors; do not pretend entitlement.
- Do not hard-code new ElevenAgents LLM enum values outside the spec. Alias model IDs remain pass-through strings.

## Validation and live-smoke plan

Focused checks:

1. OpenAPI compiler, snapshot metadata, docs-count, spec-diff, risk, multipart, aliases, CLI JSON/help, and capabilities tests.
2. Built CLI:
   - `spec diff --offline` reports no drift after refresh;
   - `ops get`/`ops schema` resolve every added operation;
   - regular, streaming, and detailed Music dry-runs include body `finetune_id`;
   - Finetune create dry-run accepts two repeated files without a request;
   - crawl cancel dry-run reports `would_require_yes: true`;
   - STT webhook dry-run emits boolean `webhook` plus `webhook_id`;
   - STT token dry-run redacts the query value and an unset token env fails with exit 2.
3. Full documented gate: `npm run build`, `npm run typecheck`, `npm test`, `npm run lint`, `npm run format:check`, plus `git diff --check`.
4. Packaged-install smoke using `npm pack` and the existing local dependencies/runtime pattern.
5. If configured auth is present, only read-only live calls: `models list`, `usage`, `music finetunes list --limit 1`, and `call list_crawl_jobs_route --limit 1`. Do not create, update, cancel, upload, generate, or spend credits. Record permission failures as untested entitlement boundaries rather than code failures.

## Rollback

The patch is one additive spec/alias/safety slice. Reverting its commit restores the July 16 snapshot and previous aliases. Runtime users can also pin or refresh a different validated spec cache without changing the package. No server state or migration is involved.

## Non-goals

- A handwritten alias for every new operation.
- Reverse-engineering private ElevenCreative UI endpoints.
- Hosting webhook receivers or the inverted Speech Engine upstream WebSocket server.
- Paid Finetune training or generation smokes.
- Guessing Finetune credit costs the official API does not publish.
- Broad dependency updates or unrelated audit cleanup.
