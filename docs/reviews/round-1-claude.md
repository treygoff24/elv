=== completionReport ===
All verification complete. Here is the review.

## Delegate completion report

- **Status:** completed (read-only; no workspace files modified — I installed `node_modules` from the lockfile and used `/tmp` scratch dirs solely to run the tests and CLI probes the prompt requested)
- **What I did:** verified the pinned snapshot (hash + counts recomputed), ran the full test suite and gates, read every core file in the `a9de3c2..HEAD` diff (spec/cache, http matching, budget, SSE/stream normalizer, secrets, WS, aliases, capabilities/ops/spec commands), and ran live CLI probes against the tsx entrypoint to confirm each finding
- **Files reviewed:** plan + 3 research docs, `src/openapi/*`, `src/core/*`, `src/commands/*` (incl. all aliases), `src/ws/*`, `src/cli.ts`, tests, docs (README, AGENTS.md, docs/api-coverage.md, skills/elv/SKILL.md, CHANGELOG)
- **Verification:** 350/350 tests pass, `tsc --noEmit` clean, `oxlint` clean, `oxfmt --check` clean. (An initial run showed 87 failures — that was purely this sandbox's over-long `$TMPDIR` breaking tsx's IPC unix socket; with a short TMPDIR everything passes.)
- **Remaining risks / follow-ups:** the findings below, chiefly the `spec update --dry-run` cache write

---

# Round 1 review: architecture and API fidelity

**Baseline verified:** `spec/openapi.snapshot.json` hashes to the pinned `de04766…c844ce`; recount gives 268 paths / 339 documented / 338 callable / 1 skipped / 1,345 schemas, matching `spec/openapi.snapshot.meta.json` and the doc claims. All 19 new operation IDs are present and compile. Counts are test-pinned at `tests/openapi/openapi-compile.test.ts:121-126`.

## Finding 1 — HIGH: `elv spec update --dry-run` writes the cache anyway

**Files:** `src/cli.ts:295` (the bug), `src/cli.ts:64` (the cause), `src/commands/options.ts:70-80`, `src/openapi/fetch-spec.ts:105`.

`addCommonFlags(program)` registers `--dry-run` on the root program. Commander then attributes `--dry-run` typed after `spec update` to the **root** command, even though the subcommand also defines it. Every other command reads flags through `mergedOptions(command)` (which walks the parent chain), but the `spec update` action reads its local `options.dryRun` directly — which is never set. Reproduced:

```
$ ELV_CACHE_DIR=<fresh> elv spec update --offline --dry-run
→ "written": true, and openapi.compact.json is created
$ elv spec diff --offline          # correct: writes nothing
```

This violates plan A3 ("`update --dry-run` is behaviorally identical to `diff`"), product-contract items 4–5, and the acceptance criterion "dry-runnable … atomic" spec refresh. Worst case: without `--offline`, an agent "previewing" upstream drift silently **replaces its active runtime cache with the live spec**. The A4 test "dry-run does not write" exists only at the library layer (`tests/openapi/openapi-update-spec.test.ts:121-133` calls `handleSpecUpdate({dryRun:true})` directly), so it can't see this commander-layer bug.

**Smallest fix:** in the `spec update` action (`src/cli.ts:292-299`), take the `command` argument and use `Boolean(mergedOptions(command).dryRun)`; add one black-box test that spawns `spec update --offline --dry-run` with a fresh `ELV_CACHE_DIR` and asserts no cache file plus `written: false`.

## Finding 2 — MEDIUM/HIGH (pre-existing): broken escape handling discards paid `json_events` output

**File:** `src/core/response-normalizer.ts:774` — `if (char === "\\\\")` compares a single character against the two-character string `\\`; the branch can never fire. Confirmed empirically: a streamed JSON event whose string value contains `\"` followed by `{` or `}` (e.g. quoted text in music/TTS metadata) makes `extractJsonObjects` mis-track string state and throw (`Unterminated string` / `Incomplete trailing JSON event`), after which `streamJsonEventsFiles` (`:725-729`) **aborts and deletes** the NDJSON and audio files — the exact "discard paid output" failure the plan's D1 partial-preservation contract was written to prevent, though D1 formally covers only SSE. The bug pre-exists `a9de3c2` (old file line 478), and the new SSE parser is *not* affected (it is line-based and correct), but this diff's streaming claims lean on this path.

**Smallest fix:** `if (char === "\\")`. Optionally extend the SSE-style partial-file preservation to `json_events`; at minimum add one test with an escaped quote + brace inside a string value.

## Finding 3 — MEDIUM: plan C3 unimplemented — RAG query classifies as `mutate`, docs say read-only

**Files:** `src/openapi/risk.ts:130-145` (no read override exists), `docs/api-coverage.md:71` ("read-only knowledge-base retrieval"), plan line 263 ("explicit `read` despite POST") and C4 ("Prove RAG query reports `read` and remains ungated" — no such test exists). CLI probe confirms: `ops get query_agent_knowledge_base_rag_route` → `risk: mutate, cost: unknown`. It remains ungated (mutate needs no `--yes`), so this is misleading discovery metadata plus a docs/CLI contradiction, not a safety hole.

**Smallest fix:** add a `READ_OP_IDS` set containing this one ID, checked at the top of `classifyRisk`, plus the C4 assertion.

## Finding 4 — MEDIUM: plan B3 partially unimplemented — no deprecation warning on invocation envelopes

**Files:** `src/core/client.ts:113-175` (`runPreparedOperation` adds only budget warnings), `src/commands/ops.ts:347-361` (annotation exists but only for `ops get`/`ops schema`). Probe: `elv call get_dubbing_resource --path dubbing_id=abc --dry-run` returns `warnings: null`. Plan B3 requires: "Successful and dry-run invocation envelopes include a deprecation warning when the active operation is deprecated." Only `agents simulate` hardcodes its own warning (`src/commands/aliases/agents.ts:306-320`).

**Smallest fix:** in `runPreparedOperation`, append a `deprecated_operation` warning to `effectiveWarnings` when `op.deprecated` (the `ops.ts` helper is reusable), plus one test.

## Finding 5 — LOW: capabilities claims an alias backs an operation no alias calls

**File:** `src/commands/capabilities.ts:34` lists `get_agent_response_tests_summaries_route` under the `agents` alias family, but nothing invokes it — `agents tests list` uses `list_chat_response_tests_route` (`src/commands/aliases/agents.ts:74-79`). A false coverage claim in the machine contract the plan calls the agent's source of truth. **Fix:** delete the entry.

## Finding 6 — LOW: doc operation counts aren't test-pinned (plan I)

Plan I: "Static operation counts must be pinned by a test or generated from snapshot metadata so they cannot drift independently." The snapshot/meta agreement is tested, but the 339/338 literals in `README.md:11`, `AGENTS.md:34`, `skills/elv/SKILL.md:8,56,88`, `docs/agent-setup.md:127`, and `docs/api-coverage.md:12-15` have no test tying them to `spec/openapi.snapshot.meta.json`. **Fix:** one small test that reads the meta file and asserts the docs contain those counts (or consciously drop the plan item).

## Intentionally covered by generic `call` (correct per plan, not gaps)

- Dubbing Project **project/language CRUD** (only transcript editing got aliases — plan E3)
- Music detailed **non-stream**, composition plans, upload, stem separation, video-to-music (plan D2)
- Agents branches, tools/MCP, knowledge-base CRUD, analytics, telephony (plan §Decision)
- Workspace admin beyond members/service-accounts (plan E2)
- **Speech Engine upstream** WebSocket excluded by design (inverted protocol); **ElevenCreative UI-only products** excluded (no published contract) — both correctly documented in `docs/api-coverage.md:79-83`

## Verified as claimed (no findings)

Atomic single-envelope cache with rename + interruption test seam (`src/openapi/registry.ts:91-115`); schema-v3 invalidation of stale compiler caches; `ELV_SPEC_URL` honored with bounded fetch (30s / 20MB, streamed byte cap); specificity-ranked HTTP template matching with ambiguity rejection (`src/commands/http.ts:166-186`, tests prove literal-beats-parameter and conflict rejection); budget fail-closed with `budget_estimate_unavailable` → exit 5, honest `unknown_unbounded` for non-generation ops; SSE parser handles split delimiters, CRLF, multiline data, `[DONE]`, malformed-tail partial preservation; secret contract (curated 3 token ops + credential-shape fallback covering `create_service_account`, 0600 files incl. `--save-json` tightening, `view` refusal, no stdout leak — all tested); WS protocol-specific validation, monitor receive-only ungated / outbound gated, exact-byte STT binary tests, dry-run never connects, raw absolute targets never get profile auth; `default_model_id` scoped to TTS REST + TTS WS only; `wait` now honors profile/base-url; deprecated ops surfaced in `ops search/list/get/schema`.

## Verdict: **approve with fixes**

Finding 1 must be fixed before this ships (it breaks a stated acceptance criterion and can silently replace the active spec cache on an explicit preview). Findings 2–4 should be fixed in this round; 5–6 are cleanups. Everything else in the plan is implemented, tested, and honestly documented.
