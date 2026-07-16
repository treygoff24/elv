=== completionReport ===
All verification is done — every load-bearing claim in the plan checked against the source. Here is the review.

## Delegate completion report

- **Status:** completed (read-only; no files modified)
- **What I did:** Reviewed `docs/plans/2026-07-16-elevenlabs-api-expansion.md` against all three research docs and the actual implementation. Verified the plan's factual claims in source: operation counts and test pins, risk/cost classification tables, the raw-HTTP matcher, budget preflight, spec refresh write order, `ELV_SPEC_URL` handling, WS keep-alive/auth/option-forwarding, redaction keys, dead `default_model_id` config, and the existence of every operation ID the plan names (agent-testing suite, token endpoints, workspace, dubbing project) in the vendored snapshot.
- **Files reviewed:** the plan, `docs/research/*.md`, `package.json`, `src/openapi/{fetch-spec,registry,compile-spec,risk}.ts`, `src/commands/{spec,http,ws}.ts`, `src/core/{client,budget,config,redaction}.ts`, `src/ws/{catalog,events,session}.ts`, plus targeted greps of tests and the snapshot.
- **Skills:** reviewed available skills; `plan-review-loop` (this task is its reviewer lane) and the project `elv` skill (CLI contract) were relevant and applied; no skill required deviation from read-only mode.
- **Remaining risks:** none beyond the findings below; the review is code-grounded but point-in-time against the synced working tree.

---

# Plan review: ElevenLabs API expansion

**Verdict: approve with revisions.** The plan is technically correct in its baseline facts, honestly scoped (generic engine + narrow aliases, no private-endpoint reverse engineering), and realistically sequenced. Every coverage number, operation ID, and defect claim I checked against the source held up. The revisions below are small; only Finding 1 would produce real bugs if the plan were executed exactly as written.

## Findings, by severity

### 1. HIGH — C1 inherits metadata through an ambiguous, order-dependent path matcher

**Plan:** Workstream C1 ("Make raw HTTP inherit matched operation metadata"). **Source:** `src/commands/http.ts:139-160`.

`matchingRegistryOperation` returns the *first* template match while iterating the registry, and the registry is sorted by operation ID — not by template specificity. After the Workstream A refresh, this ambiguity becomes concrete: `elv http GET /v1/dubbing/project` matches both the new literal template `/v1/dubbing/project` (`dubbing_project_list`) and the existing parameterized template `/v1/dubbing/{dubbing_id}` (`get_dubbed_metadata`, confirmed in the snapshot). Today the right one wins only because `d` sorts before `g`. C1 raises the stakes of a wrong match from "cosmetic risk label" to inherited cost hints, stream kind, deprecation state, and budget gating — the exact metadata C4's tests trust.

**Smallest revision:** Add one requirement to C1: matching must prefer the most specific template (literal segments beat parameter segments, deterministic tie-break), and add a C4 test using the `/v1/dubbing/project` vs `/v1/dubbing/{dubbing_id}` collision.

### 2. MEDIUM-HIGH — A2/A3 atomicity ignores the second cache writer and the cache-schema change

**Plan:** A2 ("atomically renames both files into place"), A3 (`spec status` shows "active-cache provenance, hashes"). **Source:** `src/openapi/registry.ts:34-41, 58-76` and `src/openapi/fetch-spec.ts:46-71`.

Three gaps:

1. `loadRegistry` also compiles and writes the registry cache on a cold start, via `writeRegistryCache` — a plain `writeFileSync`. A2 refactors only `updateSpecCache`; the second writer keeps the non-atomic path unless the plan says all cache writes go through the same temp-file-plus-rename helper.
2. Two sequential renames are not jointly atomic. A crash between them leaves a new raw spec beside an old compiled cache, and A3's "whether the active cache differs" signal would then report drift that is really a torn write. The plan should name the rename order and the recovery rule (e.g., the compiled cache is authoritative; a raw/compact mismatch triggers recompile, not a drift report).
3. Today's `RegistryCache` envelope has no provenance fields at all (`version`, `generated_at`, counts, cards, bundled spec). A3's status/diff contract requires adding source URL, SHA-256, and retrieved-at to the cache — a schema change the plan never states, and pre-existing caches (validated only by `version` + `operations` array at `registry.ts:44-56`) will lack it. Specify the new fields and the "provenance unknown" fallback for old caches.

### 3. MEDIUM — D1's "malformed frames must abort temp outputs" destroys paid output

**Plan:** Workstream D1, last paragraph. **Source convention:** `src/core/response-normalizer.ts:430` (JSON-event streams abort the NDJSON temp file on error).

Music detailed SSE is a paid generation. Under D1 as written, a malformed *trailing* frame — after hundreds of valid events and megabytes of successfully decoded audio — aborts the temp outputs and returns only an error. The user's credits are spent either way; deleting the audio converts a provider hiccup into total loss. The current abort convention is fine for cheap JSON event lists, not for paid generation streams.

**Smallest revision:** On malformed frames, return the structured provider-stream error *and* keep the already-written NDJSON/audio files, listed in `files[]` with a `partial: true` marker. Reserve full abort for cases where the outputs themselves are corrupt.

### 4. MEDIUM — C2's trigger is ambiguous, and the plan misses a second piece of dead budget config

**Plan:** Workstream C2. **Source:** `src/core/config.ts:119-124`, `src/core/budget.ts:32-39`, `src/core/client.ts:168-207`, `src/openapi/risk.ts:41-105`.

Two intertwined issues:

1. "If the user supplies `--max-credits`" — a ceiling can also come from `ELV_MAX_CREDITS` or the profile's `max_credits`. Today those are resolved by `loadConfig` but **never reach the budget gate**: the preflight reads only `opts.maxCredits` from the CLI flag. So profile/env ceilings are silently unenforced — dead config exactly like `default_model_id`, which Workstream H fixes while this one goes unmentioned. The plan should either wire resolved ceilings into the gate (and then C2 applies to them) or document them as unenforced. Leaving it unstated risks an implementer "helpfully" wiring them in and turning C2 into a standing hard-block.
2. The whole `slot`-hinted generation family (`text_to_voice`, `text_to_voice_design`, `create_voice` — in `GENERATE_OP_IDS` but excluded from `GUARDED_HINTS`) can never produce an estimate, so under C2 any ceiling makes them permanently exit-5. That may be the intended honest behavior, but the plan should say so explicitly (or give `slot` an exemption/estimator) rather than leave it as an accident of the hint table.

### 5. LOW-MEDIUM — A1's metadata file won't ship in the npm package

**Plan:** A1 adds `spec/openapi.snapshot.meta.json`. **Source:** `package.json` `files` whitelists only `spec/openapi.snapshot.json`.

If `spec status` reads the meta file for vendored provenance, npm installs will show nothing. Either add the meta file to `files`, or state that `spec status` computes vendored hash/counts from the snapshot bytes at runtime (making the meta file release-audit-only). One line either way — but pick one, since A3's contract promises vendored provenance.

### 6. LOW — B2's `--stream sse_events` filter value lands two waves before the enum exists

**Plan:** B2 (Wave 1) lists `--stream <none|audio_bytes|json_events|sse_events|text>`; the `sse_events` kind is created by D1 (Wave 2). `src/openapi/types.ts:6` has no such value today. Move the one-line `StreamKind` enum + compiler classification into Wave 1's metadata pass (it's part of C3-style metadata anyway), or note the filter enum grows in Wave 2.

### 7. LOW — `spec diff`'s "changed operations" conflates upstream drift with local curation

**Plan:** A3 defines changed operations "based on canonical operation-card content." Operation cards embed locally curated `risk` and `costHint` (`src/openapi/risk.ts`), so editing the curation tables (which C3 does!) would make `spec diff` report operations as "changed" against an unchanged upstream. Canonicalize the diff on upstream-derived fields only, or explicitly include curation deltas as a labeled category.

### 8. LOW — the hard-coded `eleven_v3` WebSocket rejection is never reconciled

**Source:** `src/commands/ws.ts:140-163` rejects `eleven_v3` for catalog TTS *and* raw/arbitrary URLs. Plan F4 ("do not guess TTS rules from an arbitrary URL") implicitly removes the raw-target half, and the scope boundary "no hard-coded rejection of deprecated model IDs" gestures at the philosophy, but the plan never says what happens to this block. One sentence in F1 or F4: keep the documented provider limitation for catalog TTS entries, drop it for raw targets.

### 9. NOTE (scope) — dubbing project list/get/create/delete aliases fail the plan's own admission test

The Decision section adds aliases only "where a generic JSON call is materially worse." For `elv call dubbing_project_list`, it isn't. The transcript-segment editing subcommands are the defensible part of E3; the plain CRUD wrappers are ~half the E3 surface for near-zero ergonomic gain. Optional trim, not a defect.

### 10. TRIVIAL — branch naming

The plan header targets "the current `main` branch"; the repository's default branch is `elv-build`. Verify where checkpoint commits should land before Wave 1.

## What checked out (verified, not assumed)

- Baseline and drift counts (320/319/256/1,284 vendored; 339/338/268/1,345 live; 19 additions, 0 removals) are internally consistent across all three research docs, and the current tests pin the old counts exactly where A4 says to update them (`tests/openapi/openapi-compile.test.ts:36-38`, `openapi-registry.test.ts:24-28`, `openapi-update-spec.test.ts:21`).
- Every operation ID named in E1/E2/G1 exists in the snapshot (agent-testing CRUD + test-invocations + `run_agent_test_suite_route`; `get_single_use_token`, `get_livekit_token`, `get_conversation_signed_link`).
- C3's expectations match `risk.ts` behavior precisely: `create_service_account` hits the service-account pattern → external side effect; new DELETEs → destructive by method; the RAG POST classifies as `mutate` today, so the explicit `read` override is genuinely needed. And `budget.ts:169` already matches `compose_` prefixes, so C3's `per_generation` hint activates the existing 5-minute-cap estimator with no new estimator code — a nice case of the plan reusing what's there.
- The defect premises are real: raw spec written before compile (`fetch-spec.ts:48-50`), `ELV_SPEC_URL` resolved but ignored (`config.ts:95` vs `fetch-spec.ts:8`), unknown estimates pass `--max-credits` (`budget.ts:38-39`), deprecation compiled but surfaced nowhere, `default_model_id` dead (`config.ts:90`, no other usage), TTS keep-alive rule global (`events.ts:38-44`), WS ignores dry-run/yes/budget options (`ws.ts:13-15`), raw absolute WS targets already skip profile auth (`ws.ts:119-124`), and `signed_url` absent from core redaction keys while exact-key `token` is redacted (`redaction.ts:1-11`) — so G1's curated-set approach (rather than substring matching) is the right call.

**Verdict: approve with revisions** — fold Findings 1–5 into the plan text before execution; 6–10 are one-line tightenings or optional trims.
