# Weekly ElevenLabs API parity plan

- **Date:** 2026-08-17
- **Branch:** `automation/api-sync/2026-08-17` from `origin/main` at
  `4f43f3c0`
- **Vendor contract:** ElevenLabs OpenAPI 3.1.0, `info.version` `1.0`, retrieved
  2026-08-17T14:46:37Z
- **Vendor SHA-256:**
  `c4bcaa50752fa4cc61d4e9fecdada4f387ce429b55b1eae7e1bda7e756748f06`

## Decision

Ship one additive parity update that advances the vendored API contract and
gives the new Assets, Flows, and conversation-summary resources deliberate CLI
surfaces. Fix the shared schema, multipart, budget, and credential-handling
seams that otherwise make some of those formally callable operations unsafe or
misleading.

The generic `ops`, `call`, and `http` commands remain the completeness layer.
Aliases are warranted here because Assets and Flows are coherent new product
families, while conversation summaries extend an existing high-use family.
Model-specific convenience flags for every image and video variant are not:
their request unions are still beta and can evolve through JSON input without a
CLI breaking change.

Two smaller alternatives were rejected:

1. **Refresh the snapshot only.** This would claim parity while generation
   requests bypass the configured credit ceiling, signed media URLs appear
   inline, required asset uploads omit the file, and generated examples for the
   new union request bodies do not run.
2. **Expose only generic `call`.** Technically complete, but it would leave the
   main new product families hard to discover and unnecessarily verbose for
   agents. The proposed aliases reuse existing request, wait, pagination, and
   envelope machinery instead of creating a second protocol.

## Primary evidence

The source artifact and supporting official pages were retrieved on 2026-08-17.
Context7 was queried first using `/websites/elevenlabs_io`; Exa was then used for
current official API references and the changelog.

- [Official live OpenAPI](https://api.elevenlabs.io/openapi.json): 294 paths,
  378 documented operations, 377 callable operations, one source-skipped route,
  1,452 schemas, and the SHA-256 above.
- [Official August 3 changelog](https://elevenlabs.io/docs/changelog/2026/8/3):
  documents ElevenCreative API access, including image, video, and asynchronous
  text-to-speech generation.
- [Image generation reference](https://elevenlabs.io/docs/api-reference/flows/image/create):
  documents the beta request variants, Pro-or-higher access, generation ID, and
  asynchronous status flow.
- [Video generation reference](https://elevenlabs.io/docs/api-reference/flows/video/create):
  documents the beta request variants, plan/model restrictions, generation ID,
  and asynchronous status flow.
- [Asset upload reference](https://elevenlabs.io/docs/api-reference/assets/create)
  and [asset list reference](https://elevenlabs.io/docs/api-reference/assets/list):
  document multipart upload and cursor-paginated asset discovery.
- [Conversation summary reference](https://elevenlabs.io/docs/api-reference/conversations/get-summary):
  documents the read-only summary endpoint and `max_messages` query.
- [Official documentation index](https://elevenlabs.io/docs/llms.txt): confirms
  the public reference taxonomy and separates these published endpoints from
  UI-only surfaces.

## Reproducible drift

| Measure               | Vendored August 11 | Live August 17 | Delta |
| --------------------- | -----------------: | -------------: | ----: |
| Paths                 |                285 |            294 |    +9 |
| Documented operations |                364 |            378 |   +14 |
| Callable operations   |                363 |            377 |   +14 |
| Skipped operations    |                  1 |              1 |     0 |
| Schemas               |              1,402 |          1,452 |   +50 |
| SHA-256               |      `d1a48472...` |  `c4bcaa5...` |       |

No operation was removed. Fourteen were added:

| Family | Operation IDs | Method/path summary | Disposition |
| --- | --- | --- | --- |
| Assets | `list_assets`, `upload_asset`, `get_asset`, `delete_asset_endpoint` | GET/POST `/v1/assets`; GET/DELETE `/v1/assets/{asset_id}` | Generic + `assets` aliases |
| Flows / Image | `create_image_generation`, `list_image_generations`, `get_image_generation` | POST/GET `/v1/flows/image`; GET by generation ID | Generic + `flows image` aliases |
| Flows / Video | `create_video_generation`, `list_video_generations`, `get_video_generation` | POST/GET `/v1/flows/video`; GET by generation ID | Generic + `flows video` aliases |
| Flows / TTS | `create_text_to_speech_generation`, `list_text_to_speech_generations`, `get_text_to_speech_generation` | POST/GET `/v1/flows/text-to-speech`; GET by generation ID | Generic + `flows speech` aliases |
| Agents | `get_conversation_summary_route` | GET `/v1/convai/conversations/{conversation_id}/summary` | Generic + new `agents conversations` group |

Two existing operations changed materially:

- `get_agent_topics_route` adds cursor pagination, `page_size`, `sort_by`, and
  `sort_direction`; its response now exposes `has_more` and `next_cursor`.
- `get_live_count` adds an `agent_ids` array with a 25-ID maximum, superseding
  the singular `agent_id` query.

The artifact adds 51 schemas, removes one, and changes 18. Relevant changed
contracts include `WorkspaceWebhookEventType` gaining `flows`,
`WorkspaceResourceType` gaining `convai_agent_experiments` and
`content_skills`, `LLM` gaining `gemini-3.7-flash`, turn configuration gaining
`merge_with_default_ignore_terms`, soft-timeout configuration gaining
`disable_until_first_user_message`, and workspace group responses dropping
`scim_external_id`. These remain generated-contract changes rather than new
handwritten types.

## Capability matrix

Tag counts overlap because the vendor assigns some operations to several
families. "Generic" means compiled `elv call` coverage, with `http` retained as
the ahead-of-snapshot REST escape hatch.

| Official family | Live evidence | Current CLI | Weekly disposition |
| --- | --- | --- | --- |
| Voices, cloning, PVC, samples | 23 voices, 14 PVC, 2 sample memberships | Generic + `voices` | Covered; refresh schemas |
| Text to Speech / dialogue / text-to-voice | 4 TTS, 4 dialogue, 5 text-to-voice memberships | Generic + `tts` + WS | Add asynchronous Flows TTS aliases and character cost hint |
| Speech to Speech | 2 operations | Generic + `voice-change` | Covered |
| Audio isolation | 4 operations | Generic + `voice-isolate` | Covered |
| Dubbing / Dubbing Project | 17 Dubbing plus 47 compatibility memberships | Generic + `dubbing` + `dubbing-project` | Covered |
| ElevenAgents / conversations / insights | 148 Agents Platform, 7 Conversational AI, 1 Insights | Generic + `agents` + WS | Add conversation-summary alias; refresh topics/live-count contracts |
| Knowledge bases / tools / integrations | Included under Agents Platform and resource tags | Generic + Agents aliases | Covered |
| Studio / projects / productions / Audio Native | 23 Studio, 11 Productions, 4 Audio Native | Generic | Covered |
| Pronunciation dictionaries | 9 operations | Generic | Covered |
| Sound effects | 1 operation | Generic + `sfx` | Covered |
| Music / Finetunes / video-to-music | 7 generation, 5 Finetunes, 1 video operation | Generic + `music` | Covered |
| Speech to Text / transcription | 3 REST plus realtime WS | Generic + `stt` + WS | Covered |
| History | 5 operations | Generic + `history` | Covered |
| Usage / models / analytics | Models, subscription, usage, 2 workspace-analytics routes | Generic + `usage` + `models` | Covered |
| Webhooks / events | Workspace CRUD and event schemas | Generic | Refresh `flows` event enum; receiver remains out of scope |
| Workspaces / admin | 29 workspace memberships plus enterprise routes | Generic + `workspace` | Covered |
| Batch / async / streaming | Flows jobs, dubbing, tests, crawl, SSE, REST, WS | Generic + `wait` + stream normalizers | Add Flows create/get/list and optional wait |
| Files / media | New Assets plus existing multipart/binary/audio/ZIP/CSV | Generic file handling | Add Assets aliases and fix required multipart file routing |
| Flows / Image / Video | 9 Flows operations: 3 each for Image, Video, and async TTS | Generic only | Add curated `flows` aliases and safety curation |
| Beta / newly published surfaces | Image and Video beta references; all 14 operations in OpenAPI | `call` / `http` | Cover published contract; no private-editor reverse engineering |

## Confirmed gaps and root-cause changes

### 1. Refresh the vendored contract and provenance

Replace `spec/openapi.snapshot.json`, update
`spec/openapi.snapshot.meta.json`, and advance counts, hashes, dates, taxonomy,
and exclusions in:

- `README.md`
- `AGENTS.md`
- `skills/elv/SKILL.md`
- `docs/agent-setup.md`
- `docs/api-coverage.md`
- `CHANGELOG.md`
- `src/commands/capabilities.ts`

Update the count/provenance tests to require 378 documented and 377 callable
operations. Assert all 14 additions compile, the two changed operations expose
their new query/response contracts, and representative new schemas survive the
compact registry.

### 2. Treat Flows creation as generation, not an ordinary mutation

Add all three create IDs to the shared generation-risk set. Give asynchronous
TTS its existing character-count cost hint: every live request variant requires
a top-level `text` string, which the existing estimator reads. Require a
non-empty variant test so a future schema change cannot silently estimate billed
text as zero.

Do not invent an image/video credit formula that the published contract does not
provide. With a configured credit ceiling, those requests fail closed under the
existing `estimate_unavailable` policy (exit 5), which `--yes` cannot override.
Without a ceiling they run ungated, like the CLI's other `generate` operations;
generation does not independently require `--yes`. This means an agent with a
default `max_credits` profile must explicitly remove that ceiling to run image
or video Flows generation. Test both ceiling cases, with and without `--yes`,
through aliases, generic `call`, and matching `http` requests.

### 3. Spill signed `content_url` values instead of returning them inline

The new Asset and Flows responses carry expiring signed media URLs in fields
named `content_url`. Extend both structured credential detection and string
redaction to recognize that key. Keep the complete provider response in the
existing mode-`0600` sensitive file, but also return a structurally intact
redacted `data` value in the envelope for dynamically detected credentials.
Explicit token/signed-link operations curated through `secretResult` retain
their current no-`data` behavior.

The redacted structural copy is required so status polling, `data.next.cmd`,
`--all`, and `--fields` continue to work. Tests must show that nested Asset and
Flows lists expose their real metadata and cursors with every `content_url`
replaced, `--all` writes only redacted items, and a terminal Flows response both
reaches `completed` and points at the sensitive raw response file. Do not fetch
the media automatically or print its signed URL in errors, dry runs, tests, or
logs. A global key is intentional here: the vendor defines `content_url` as a
signed, roughly one-hour URL in both public response families, and conditional
detection avoids spilling in-progress objects that do not contain it.

### 4. Make root-union examples and flat JSON input runnable

The new image, video, and asynchronous TTS request bodies use root `oneOf`
unions. The current compact-schema/example path wraps the first variant under a
synthetic `value` property, so the generated command fails validation. Resolve
the first useful object variant for compact-schema and example generation and
emit its fields directly under the structured `body` bucket. Do not expand flat
key routing across union variants: structured `body` input and the JSON-first
aliases already work and avoid new path/query/body ambiguity. Add tests for all
three examples, local validation of representative variants, and preservation
of the existing synthetic `value` behavior for genuinely non-object root
bodies.

### 5. Route required multipart files through `--file`

`upload_asset` requires the binary `asset` field and a `name`. Generated examples
currently place a path string in `body.asset`, while the multipart builder sends
file bytes only from `files[]`; the resulting request can pass local validation
and omit its required upload. Generate `--file asset=./input` for required
binary multipart fields, exclude those fields from JSON-body satisfaction, and
reject missing files locally. Preserve current body-field behavior for
non-binary multipart data and cover one existing multipart operation as a
regression.

### 6. Add focused aliases without duplicating the transport

Add these aliases, all implemented through `runAlias`, `runListAlias`, existing
JSON/file readers, shared wait support, and registry-derived safety:

```text
assets list [--search TEXT] [--cursor CURSOR] [--limit N | --all]
assets get --id ASSET_ID
assets upload --file PATH [--name NAME]
assets delete --id ASSET_ID --yes

flows image  create --json ... [--wait] [--timeout-ms N]
flows image  get --id GENERATION_ID
flows image  list [--status STATUS] [--model-id ID] [--cursor CURSOR] [--limit N | --all]
flows video  create --json ... [--wait] [--timeout-ms N]
flows video  get --id GENERATION_ID
flows video  list [--status STATUS] [--model-id ID] [--cursor CURSOR] [--limit N | --all]
flows speech create --json ... [--wait] [--timeout-ms N]
flows speech get --id GENERATION_ID
flows speech list [--status STATUS] [--model-id ID] [--cursor CURSOR] [--limit N | --all]

agents conversations summary --conversation-id ID [--max-messages N]
```

`assets upload` maps `--file PATH` to multipart `files.asset`; the vendor requires
`name`, so an omitted `--name` defaults to the file basename. Under a configured
credit ceiling this unpriced `mutate` operation follows the existing
`unknown_unbounded` consent path and requires `--yes`; test the alias, `call`,
and `http` behavior.

All four new list endpoints declare `page_size`, `cursor`, `next_cursor`, and
`has_more`, so the existing fallback pagination code should work without a new
family. Prove that rather than curating them: `--limit` maps to `page_size`, an
explicit `--cursor` resumes, `data.next.cmd` advances, and `--all` collects the
`assets` or `generations` array. The explicit cursor flag is local to these new
aliases; older list aliases remain unchanged.

Flows `--wait` uses create response key `id`, path key `generation_id`, status
path `$.data.status`, success `completed`, and failure `failed`. The get
operations are respectively `get_image_generation`, `get_video_generation`, and
`get_text_to_speech_generation`. Extend the shared wait helper to accept the
alias's optional `--timeout-ms`; without it the existing ten-minute default and
exit-7 recovery behavior remain. JSON input remains the stable way to express
model-specific beta unions.

Register the new `agents conversations` parent, all operation IDs in the sorted
capability-family registry, and parent help behavior. Add focused
help/builder/pagination/wait/safety tests plus offline smoke entries for bare
`assets`, `flows`, and `agents conversations` parents.

### 7. Correct documentation and intentional exclusions

Remove the existing statement that ElevenCreative image/video workflows are
absent from the public API in both top-level docs and
`skills/elv/references/media-workflows.md`; sweep the remaining shipped skill
references for the same stale claim. Document published Assets and Flows
coverage, beta and plan restrictions, JSON-first union input, signed-media spill
behavior, and the absence of a defensible local image/video credit estimate.
Add a new changelog entry rather than rewriting historical entries.

Keep these exclusions explicit:

- no private UI endpoint discovery or reverse engineering;
- no hosted webhook receiver, server-side Speech Engine, or automatic asset
  download;
- no handwritten copy of the vendor's beta image/video model unions;
- no paid generation, upload, deletion, outbound call, or other mutating live
  smoke during this unattended run.

## Implementation order and ownership

1. **Contract/core lane:** `spec/openapi.snapshot.json`, its metadata, compact
   root unions, multipart validation/examples, generation risk, signed-URL
   detection and structural redaction, shared wait timeout plumbing, and focused
   contract tests. These changes are coupled because each affects generic
   `call` and alias behavior. This lane lands first.
2. **Alias lane:** new alias source files, `agents.ts`, alias registration,
   `src/commands/capabilities.ts`, help, and focused alias/smoke tests. It starts
   after the refreshed contract is present and consumes core behavior rather
   than adding alias-local safety or transport rules.
3. **Integration/docs lane:** `README.md`, `AGENTS.md`, `skills/elv/SKILL.md`,
   shipped skill references, `docs/agent-setup.md`, `docs/api-coverage.md`,
   `CHANGELOG.md`, count assertions, and installed-runtime verification after
   both code lanes merge.

Native Codex subagents own the two implementation lanes; the root agent owns
snapshot integration, conflict resolution, final diff review, validation, and
release judgment.

## Compatibility and migration risk

The command additions are backward compatible. Deliberate behavior changes are:

- dynamically detected credential responses now expose a redacted structural
  `data` copy alongside the sensitive mode-`0600` raw file;
- `ops schema --example` stops inventing `body.value` for root unions and emits
  a runnable first object variant;
- required multipart file fields supplied only as body strings now fail local
  validation instead of reaching the provider without file bytes.

The last two fixes affect all operations sharing those constructs, not only the
new routes. Regression tests must cover existing multipart and root-union
operations alongside the new ones. Snapshot enum/model changes can reject values
removed by the vendor; that is contract parity rather than a handwritten CLI
migration. `get_live_count` retains `agent_id`; the new 25-item `agent_ids` array
takes precedence when both are supplied.

## Verification plan

The pre-change baseline passed `npm run gate` after `npm ci`: 69 test files, 432
tests, and 18 offline smoke cases.

After implementation:

1. Run focused Vitest files for compact schema/examples, request building,
   multipart validation, redaction/response normalization, risk/budget/safety,
   pagination/wait, aliases, and OpenAPI provenance/counts. Count changes must
   cover `tests/commands/capabilities-contract.test.ts`,
   `tests/openapi/openapi-update-spec.test.ts`,
   `tests/openapi/openapi-registry.test.ts`,
   `tests/openapi/openapi-compile.test.ts`, and
   `tests/openapi/docs-coverage-counts.test.ts`.
2. Run `npm run format:check`, `npm run lint`, `npm run typecheck`,
   `npm run build`, `npm run test`, and `npm run smoke` through the canonical
   `npm run gate`.
3. Run `npm run smoke:pack` against an unpacked package.
4. Rebuild and run `elv --version` plus
   `ELV_BIN="$(command -v elv)" npm run smoke` against the installed runtime.
5. Where existing credentials permit, run read-only live envelopes for models,
   usage, one voice page, Assets lists, all three Flows lists, and Agents lists.
   Exercise conversation summary only if a conversation ID can be discovered
   without mutation. Do not render or log sensitive response artifacts.
6. Recompute the final contract counts and SHA from checked-in artifacts and
   inspect the package tarball contents.

## Review gates

Before implementation, send this plan to independent Claude and Cursor
(Grok 4.5) safe reviewers using the same bounded, read-only brief. Patch every
actionable plan finding before source changes.

That review completed on 2026-08-17 with two `APPROVE WITH REVISIONS` verdicts.
The plan now corrects generation budget semantics, preserves redacted structural
data for pagination/wait, pins TTS estimation and Flows wait contracts, confirms
the new pagination fields and required asset name from the refreshed artifact,
removes risky flat-union routing, assigns files to one lane, and expands shipped
documentation coverage. The suggestion to stop before push was not adopted:
the automation prompt explicitly authorizes a feature-branch push and
ready-for-review PR after all gates pass. Flows list aliases remain because they
are read-only, cursor-aware, and share one small builder rather than duplicating
transport code.

After a green implementation, obtain independent full-diff reviews from Cursor
Grok 4.5, Claude, and Codex Sol at xhigh reasoning. Require severity, file/line
evidence, and coverage of correctness, API parity, regressions, security, agent
ergonomics, and tests. Patch actionable findings with native Codex subagents,
rerun focused and full checks, inspect the final diff, and run one fresh Codex
Sol xhigh review on the post-fix diff. A reviewer verdict never substitutes for
green validation.

## Rollback and release

The update is one feature branch and must not be merged by the automation. If a
shared-seam regression cannot be resolved, revert the affected commit on this
branch or leave the branch unpushed and report the exact blocker. Do not publish
a partial snapshot whose counts, generated registry, docs, and runtime behavior
disagree.

When the final gate, package smoke, installed-runtime smoke, allowed live reads,
and review gates are green, commit and push the branch and open a ready-for-review
PR. The PR must include primary-source evidence, the gap matrix, compatibility,
validation and live-smoke receipts, all review/fix rounds, and residual limits.
Do not merge or publish a package.
