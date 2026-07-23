# Weekly ElevenLabs API parity plan

**Date:** 2026-07-27
**Branch:** `automation/api-sync/2026-07-27` from local `main` at `b673cac`
**Open predecessor:** [PR #2](https://github.com/treygoff24/elv/pull/2) at `a983819`
**Vendor contract:** ElevenLabs OpenAPI `info.version` `1.0`, retrieved
2026-07-27 at 13:05:13Z
**Vendor SHA-256:** `494d96419d152f22c717162b89cd2c4c0e5b913d1f4fd39d935dfe83fce529dc`

## Decision

Reuse the already-reviewed July 23 parity commit, refresh its contract to today's
OpenAPI, and make three shared agent-facing corrections exposed by the new
operations:

1. classify the bulk dependent-agent lookup as read-only despite its POST method;
2. classify bulk knowledge-base deletion as destructive so `--yes` is required;
3. make generated examples for required arrays contain one placeholder instead of
   an invalid empty array.

Do not add handwritten aliases for the three new operations yet. The generic
`ops`/`call`/`http` path already covers them, and ElevenLabs has not published
their individual API-reference pages or a post-July-20 changelog entry. A partial
`agents batch-calls` or `agents knowledge-base` namespace would duplicate the
registry and create an unstable command contract before the vendor documentation
settles.

## Primary evidence

Retrieved on 2026-07-27:

- [Official live OpenAPI](https://api.elevenlabs.io/openapi.json): 277 paths,
  352 documented operations, 351 callable operations, one source-skipped
  deprecated route, 1,372 schemas, SHA-256 above.
- [Official API-reference index](https://elevenlabs.io/docs/llms.txt): the latest
  published operation index. It lists the pre-existing single-document dependent
  lookup but not the three new routes.
- [Official July 20 changelog](https://elevenlabs.io/docs/changelog/2026/7/20.md):
  the latest changelog entry in the official index. It documents Music Finetunes,
  crawl jobs, conversation-reference resolution, STT token/webhook changes, and
  field/default changes already addressed by PR #2.
- [Official authentication reference](https://elevenlabs.io/docs/api-reference/authentication):
  `xi-api-key` authentication, scoped keys, quotas, and IP allowlisting.
- [Official webhook reference](https://elevenlabs.io/docs/eleven-api/resources/webhooks):
  workspace webhook event types, HMAC verification, retry behavior, and
  idempotent receiver requirements.

Context7 was queried first using `/websites/elevenlabs_io` and corroborated the
official authentication, webhook, realtime, and API-reference contracts. Exa was
invoked for official changelog search but returned HTTP 402
`insufficient_credits`; this plan therefore uses direct official vendor
artifacts for primary-source evidence.

### Reproducible drift

| Measure | Local July 16 | Open PR July 23 | Live July 27 |
| --- | ---: | ---: | ---: |
| Paths | 268 | 274 | 277 |
| Documented operations | 339 | 349 | 352 |
| Callable operations | 338 | 348 | 351 |
| Skipped operations | 1 | 1 | 1 |
| Schemas | 1,345 | 1,367 | 1,372 |
| SHA-256 | `de047661...` | `d79f40a5...` | `494d9641...` |

PR #2 already covers the ten July 16 -> July 23 additions. July 23 -> July 27 adds
exactly three operations and removes or changes no same-ID operations:

| Operation | Method and path | Contract |
| --- | --- | --- |
| `export_batch_call` | `GET /v1/convai/batch-calling/{batch_id}/export` | Terminal batch-call recipients and results as binary `text/csv` |
| `get_knowledge_base_bulk_dependent_agents_route` | `POST /v1/convai/knowledge-base/dependent-agents` | Read-only lookup for 1-20 unique document/folder IDs; cursor pagination, page size 1-100/default 30 |
| `post_knowledge_base_bulk_delete_route` | `POST /v1/convai/knowledge-base/bulk-delete` | Independently delete 1-20 document/folder IDs; optional `force=false`; mixed per-ID success/failure map |

Five schemas were added: the two request bodies, two bulk-delete response
schemas, and `KnowledgeBaseRagChunkModel`. Two existing schemas changed:
`KnowledgeBaseRagToolResultModel` now carries retrieved chunks, and
`WebhookUsageType` adds `Flows`.

The current compiler successfully compiles today's spec and marks
`export_batch_call` as `returnsBinary: true`, `streamKind: none`, and `risk:
read` because the official `text/csv` response schema is `type: string, format:
binary`. The response pipeline also spills runtime `text/csv` to `files[]`
through its text-stream path; no new media abstraction is needed. Pin both the
schema-derived metadata and the `.csv` spill behavior in tests.

## Capability matrix

Counts below are OpenAPI tag memberships and may overlap when one route has
multiple tags or compatibility paths. "Generic" means validated `elv call`
coverage plus `http` for ahead-of-snapshot REST. Aliases are ergonomic shortcuts,
not the completeness mechanism.

| Official family | Live contract evidence | Existing CLI path | Weekly disposition |
| --- | --- | --- | --- |
| Voices, cloning, PVC, samples | 20 voices + 14 PVC + 2 sample memberships | Generic + `voices` | Covered; refresh schemas/enums |
| Text to Speech / dialogue | 8 operations | Generic + `tts` + named realtime WS | Covered |
| Speech to Speech | 2 operations | Generic + `voice-change` | Covered |
| Audio isolation | 4 operations | Generic + `voice-isolate` | Covered |
| Dubbing | 15 current Dubbing Project operations plus compatibility routes | Generic + `dubbing` + `dubbing-project` | Covered |
| ElevenAgents / conversations | 139 Agents Platform memberships plus testing/analytics routes | Generic + `agents` + `convai`/monitor WS | Add all three operation IDs through the spec |
| Knowledge bases / tools / integrations | Included in Agents Platform and 7 crawl/folder routes | Generic + `agents rag-query` | Fix read/destructive classification; no premature alias |
| Studio / projects / productions | 23 Studio + 11 Productions + 4 Audio Native | Generic | Covered; no duplicate alias tree |
| Pronunciation dictionaries | 9 operations | Generic | Covered |
| Sound effects | 1 operation | Generic + `sfx` | Covered |
| Music / Music Finetunes / video-to-music | 7 generation + 5 Finetunes + 1 video | Generic + PR #2 `music` aliases | Integrate PR #2; no July 27 delta |
| Speech to Text / transcription | 3 REST operations plus realtime WS | Generic + PR #2 `stt` + named realtime WS | Integrate token/webhook fix from PR #2 |
| History | 5 operations | Generic + `history` | Covered |
| Usage / models | models, subscription, usage, analytics routes | Generic + `usage` + `models` | Covered |
| Webhooks / events | 4 workspace CRUD routes plus webhook schemas | Generic | Covered outbound API; receiver server remains out of scope |
| Workspaces / admin | 29 workspace memberships plus usage/admin routes | Generic + `workspace` | Covered |
| Batch / async / streaming | Batch calls, crawl jobs, tests, dubbing, SSE, REST and WS streams | Generic + `wait` + streaming normalizers | Add CSV export; existing async/polling primitives hold |
| Files / media | Multipart upload and binary/audio/CSV downloads across families | Generic file handling | CSV already compiles as binary and spills safely |
| Beta / new surfaces | Included when published in OpenAPI | `call`, `http`, `ws` | No private endpoint reverse engineering |

## Confirmed gaps and root-cause changes

### 1. Integrate the open July 23 parity work

Reuse commit `a983819` rather than reimplementing its spec refresh, Music
Finetunes aliases, STT webhook/token correction, crawl cancellation safety,
pagination correction, and documentation. A merge-tree preview found content
conflicts only in:

- `src/commands/aliases/music.ts`
- `src/commands/aliases/stt.ts`

Resolve those by preserving local `main`'s newer Commander/validation patterns
and PR #2's vendor semantics. Conflict resolution must combine both sides rather
than prefer either file wholesale:

| Area | Keep from local `main` | Keep from `a983819` |
| --- | --- | --- |
| `music.ts` | Current `runAlias`, `mergedOptions`, and validation wiring | Music Finetunes lifecycle and generation `finetune_id` |
| `stt.ts` | Current `validationOrExit` and command wiring | Configured webhook ID semantics and environment-sourced single-use token |
| `capabilities.ts` | Current structure and descriptions | July 23 Music/STT operation IDs, then advance counts to July 27 |
| `risk.ts` | Current fingerprint/type shape | Crawl cancellation override, then add both July 27 POST overrides |
| Docs/tests | Current gate/smoke conventions | PR #2 migration, aliases, pagination, provenance, and coverage assertions |

The auto-merged `risk.ts`, `capabilities.ts`, `openapi-compile`,
`openapi-registry`, `openapi-update-spec`, and `capabilities-contract` files
will initially contain July 23 state and must be advanced to July 27 after the
integration. Retain the July 23 plan on its PR branch/Git history if it is not
carried into this branch.

### 2. Refresh the vendored contract and provenance

Replace `spec/openapi.snapshot.json`, update
`spec/openapi.snapshot.meta.json`, and update pinned counts/hash/date in:

- `README.md`
- `AGENTS.md`
- `skills/elv/SKILL.md`
- `docs/agent-setup.md`
- `docs/api-coverage.md`
- `CHANGELOG.md`
- `src/commands/capabilities.ts`

Update the count/provenance tests and assert all three new operation IDs compile.
Assert `export_batch_call` is a binary CSV read and that both bulk operations
retain their body limits/defaults and pagination fields. Add a runtime response
regression proving `text/csv` is written as a `.csv` file in `files[]` and never
inlined in `data`.

### 3. Correct shared safety metadata

In `src/openapi/risk.ts`:

- add `get_knowledge_base_bulk_dependent_agents_route` to the curated read set;
- add `post_knowledge_base_bulk_delete_route` to the curated destructive set.

This is the single shared seam used by `call`, matching raw `http`, dry-run
previews, `ops get`, confirmation checks, and registry fingerprints. Do not add
alias-local confirmation logic.

Extend `tests/openapi/openapi-risk.test.ts` and
`tests/openapi/curated-confirmation-contract.test.ts` so the read-only POST stays
ungated and bulk deletion is refused before any network call unless `--yes` is
present. Dry-run must remain network-free and report `would_require_yes`.

Land the July 27 snapshot and both risk-curation additions atomically. The
confirmation-contract test asserts every curated operation ID exists in the
compiled snapshot, while publishing the snapshot without the destructive
override would briefly expose an ungated delete route.

### 4. Generate valid required-array examples

`buildExampleCommand` currently turns every required array into `[]`, even when
the schema says `minItems: 1`. The compact schema already preserves the array's
`items` shape. Change only the shaped-array branch in `placeholderFor` to emit
one placeholder from that existing item shape; leave the shapeless string
`"array"` fallback as `[]`. Optional arrays remain omitted. For the new bulk
operations, the generated body should be:

```json
{"document_ids":["<document_ids>"]}
```

Keep optional arrays omitted. Do not build a general example synthesis engine;
one item from the existing item shape is sufficient. Add a focused regression
in `tests/openapi/openapi-compact-schema.test.ts` asserting the generated command
contains `"document_ids":["<document_ids>"]` and does not contain
`"document_ids":[]`.

## Compatibility and migration risk

- REST coverage increases from 348 to 351 callable operations over the open PR
  baseline; no operation is removed or newly deprecated.
- Bulk dependent-agent lookup changes only machine metadata from `mutate` to
  `read`; requests remain identical.
- Bulk deletion now correctly exits 4 without `--yes`. This is an intentional
  safety tightening for a newly introduced operation.
- Required-array example strings change from invalid `[]` to one placeholder.
  Scripts should not treat generated examples as a stable byte-for-byte API;
  the envelope schema and operation input schema remain stable.
- Integrating PR #2 also carries its documented STT migration: a literal webhook
  URL is rejected in favor of a configured workspace webhook ID, and single-use
  tokens come from an environment variable rather than argv.
- No dependency, envelope-version, exit-code, or config-file change is planned.

## Validation and live-smoke plan

Baseline on local `main` is green: format, lint, typecheck, build, 69 test files /
397 tests, and 17 offline smoke invocations.

After implementation:

1. run focused OpenAPI, risk, example, alias, pagination, and response tests;
2. run `npm run gate`;
3. run `npm run smoke:pack`;
4. rebuild the installed `elv`, verify `elv --version`, then run
   `ELV_BIN="$(command -v elv)" npm run smoke`;
5. verify `ops get` and `ops schema --example` for all three new operations;
6. run offline dry-runs with sentinel IDs and no network:
   - bulk delete reports `would_require_yes: true`;
   - bulk dependent-agent lookup does not report `would_require_yes`;
   - matching raw `http` metadata applies the same risk classes;
7. run authenticated read-only smokes only when existing auth is present:
   models, usage, Music Finetunes list, crawl jobs list, and knowledge-base
   dependent-agent lookup if a safe existing document ID is discoverable;
8. do not invoke bulk delete, create/update Finetunes, start/cancel crawl jobs,
   generate media, make calls, or perform other credit-consuming/mutating work;
9. do not export batch-call recipient data without a user-selected terminal
   batch ID; compiler and mock/runtime binary tests cover that boundary.

Every command must keep the one-envelope stdout contract, and all auth values,
tokens, signed URLs, and other credentials must stay redacted or in mode-0600
sensitive files.

## Rollback

Revert the parity commits. The previous vendored snapshot remains available in
Git, and registry cache fingerprints force recompilation when the bundled spec
or risk curation changes. No remote or provider state is mutated by the planned
implementation or validation.

## Non-goals and residual boundaries

- No private ElevenCreative, Reception.ai, UI-only, or reverse-engineered route.
- No inbound webhook server; the CLI manages published webhook resources only.
- No Speech Engine upstream client: ElevenLabs connects to a customer-hosted
  server, so the existing REST resource management surface is the correct CLI
  boundary.
- No handwritten alias until the vendor publishes a stable operation family or
  evidence shows repeated generic-call friction.
- No paid generation, outbound call/message, deletion, or admin mutation smoke.
- API-reference pages and changelog text lag today's authoritative OpenAPI for
  the three new operations; retain that provenance distinction in the PR.
