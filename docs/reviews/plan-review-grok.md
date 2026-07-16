=== completionReport ===
I'll run a read-only adversarial review of the ElevenLabs API expansion plan against the research docs and current repo. First I'll load relevant skills, then map the plan against research and source.Continuing with the full plan and research docs, then grounding findings in safety, HTTP, WebSocket, and budget code.Next I'll finish the plan and inspect safety, HTTP, WebSocket, budget, and cache-write paths for concrete failure modes.Checking a few last security and STT protocol details before writing the review.## Skills reviewed (mandatory)

| Skill | Applied? | Why |
| --- | --- | --- |
| `plan-review-loop` | Yes | Code-grounded adversarial plan review |
| `planning-workflow` | Yes | Ground claims against real seams |
| `agentfit` / `elv` | Yes | Agent contract, safety, budget, discovery |
| Others | No | Not needed for a read-only plan review |

**Mode:** Delegate Grok safe / read-only. No files mutated.

---

# Adversarial plan review: ElevenLabs API expansion

**Document:** `docs/plans/2026-07-16-elevenlabs-api-expansion.md`
**Grounded against:** research trio + `src/commands/http.ts`, `src/openapi/fetch-spec.ts`, `src/openapi/risk.ts`, `src/core/{budget,client,redaction,files,safety}.ts`, `src/ws/{catalog,events,session}.ts`, alias surface

**Overall:** Strong strategy (generic `call` + thin aliases + fix real P0 gaps). Several security and honesty holes would ship false safety or incomplete “realtime coverage.” Not a reject — **approve with revisions**.

---

## Findings (severity order)

### 1. Critical — Dual-file “atomic” cache update is not atomic

**Plan:** Workstream A2 steps 5–6; Acceptance “atomic”; Product contract #5
**Code:** `src/openapi/fetch-spec.ts` currently writes raw **before** compile (`writeFileSync` then `compileSpec`), which the plan correctly wants to fix — but A2 still says “atomically renames **both** files into place.”

**Failure:** Process dies after renaming `openapi.raw.json` but before `openapi.compact.json`. Next cold load prefers raw (`registry.ts` prefers `rawSpecCachePath` when present) and recompiles a candidate that never fully passed the intended pair-commit, or runs against mixed generations under concurrent `spec update`.

**Revision:** Specify one of: (a) write both to a temp directory then `rename()` the directory, or (b) write `*.tmp` for both, fsync, rename compact first then raw (or vice versa with documented recovery), plus a single-process lock file. Tests must kill mid-rename and assert last known-good pair remains loadable.

---

### 2. Critical — Secret-result contract still leaks via existing chokepoints

**Plan:** G1–G3
**Code:** `src/core/redaction.ts` (no `signed_url`); `src/ws/events.ts` (has `signed_url`); `src/core/response-normalizer.ts` spill/`--save-json` writes unredacted JSON with default perms; `src/commands/view.ts` reloads file then `success()` → `writeEnvelope` → `redact()`.

**Failures:**

1. Agent runs `elv call get_conversation_signed_link` → file is `0600` and correct, then `elv view <file>` → stdout re-redacts `token`/`signed_url` keys → unusable secret, or path is wrong if only key names are redacted inconsistently.
2. Non-curated responses still emit `signed_url` / `conversation_token` on stdout (core redactor gap vs research P0 #4 in `docs/research/cli-coverage-baseline.md`).
3. Agent uses `--save-json /tmp/out.json` on a secret op → plan says “cannot downgrade permissions” but does not forbid writing secrets to a user-chosen world-readable path or say `view`/`cat` policy.

**Revision:** Expand G1 field list to at least `token`, `signed_url`, `conversation_token`, `conversation_signature`, LiveKit/WebRTC auth fields used by those ops. Require: secret spill **only** under output dir with `0600`; reject or force-redirect `--save-json` for secret ops; add `elv view --reveal-secrets` gated or document “use OS read, never `view`”; unify core redaction with WS secret keys for non-secret-result paths.

---

### 3. High — Budget fail-closed is narrower than agents will believe

**Plan:** C2; Product contract / Workstream I “what `--max-credits` can estimate”; residual limits
**Code:** `overBudget` only when estimate ≠ null (`budget.ts`); HTTP synthetic op drops `costHint` (`http.ts` lines 111–136); 289/319 ops are `costHint: unknown` (baseline).

**Failure:** Operator sets `ELV_MAX_CREDITS=50` expecting a hard ceiling. Agent runs:

- `elv http POST /v1/text-to-speech/{id}` **before** C1 ships → null estimate → network + bill
- After C1/C2: `elv call` on a paid-ish op still classified `mutate` + `unknown` → still bills
- C2 only fails closed for `risk === generate`

Marketing of “budget protection” remains false for most of the registry.

**Revision:** C2 must cover **any** op where `GUARDED_HINTS` would apply **or** risk is `generate` **or** costHint is known-but-unestimable (duration missing). For `unknown`, dry-run and live must set `would_exceed_budget: null` / `budget_policy: "unknown_unbounded"` and document that `--max-credits` is **not** a global spend lock. Prefer fail-closed on unknown **when** `--max-credits` is set **and** `risk` is `generate` **or** stream/media generation tags — already partly there; extend to matched HTTP + WS the same way. Add an acceptance bullet: “unknown + max-credits never silently proceeds for generate/stream ops.”

---

### 4. High — Realtime STT / agent conversation claims outrun Workstream F

**Plan:** Product contract #10; F1–F5; Acceptance “TTS, multi-context TTS, realtime STT, agent conversation, and conversation monitor…”
**Research:** baseline WS section — JSON-only send, TTS keep-alive first frame, no binary frames; `convai` `scriptable: false`
**Code:** `events.ts` `parseSendScript` requires keep-alive; `session.ts` `sendJson` only; inbound forced UTF-8 string.

**Failure:** After F1 removes keep-alive for STT, scripts still cannot send binary audio chunks required for realtime STT. Catalog still marks `convai` non-scriptable unless F explicitly flips it and adds duplex/`wait` actions. Acceptance will green on “catalog + no TTS rule” while real STT/agent workflows still fail — same false-coverage class as today’s README.

**Revision:** Split claims:

- **Must ship:** protocol tags, dry-run/yes/budget, monitor, raw-auth rules, TTS keep-alive scoped.
- **Honest residual or extra F6:** STT binary/`file` send actions + mock binary round-trip; either implement a minimal scriptable agent protocol **or** keep `convai` non-scriptable and change product/acceptance language to “cataloged; scripted player not supported (signed-URL browser/runtime path).”

---

### 5. High — Raw HTTP inheritance + path match first-hit is underspecified

**Plan:** C1
**Code:** `matchingRegistryOperation` returns first template match; synthetic card zeros `streamKind`, `costHint`, `returnsBinary`, etc.

**Failures:**

1. Matched Music SSE path still treated as non-stream until full card fields are copied (plan says this; good) — must include `operationId` for budget helpers that key off ID (`isMusicGeneration` uses `compose_*`).
2. Ambiguous templates (overlapping patterns) pick arbitrary first Map order → wrong risk/budget.
3. Dry-run “matched vs inferred” is specified; live envelopes should too.

**Revision:** C1 must copy full card fields needed by runner (id, costHint, streamKind, responses, returnsBinary, pagination, deprecated, risk) while overriding path with concrete request path. Define deterministic match: exact length + fewest params, or reject multi-match. Tests for TTS budget **and** `compose_detailed_stream` SSE via `http`.

---

### 6. Medium — Dubbing Project alias surface is high cost / unconfirmed GA

**Plan:** E3 (~15 subcommands); Decision “thin workflows”; research open questions on tier/migration
**Evidence:** `docs/research/elevenlabs-api-2026-07-16.md` — 15 project ops present in OpenAPI; release stage / migration from Resource API unconfirmed.

**Failure:** Wave 3 burns large alias+test surface for ops that may 403 on the test account or be beta; agents learn a second dubbing tree that may not replace automatic dubbing. Cost exceeds value vs `call` + ops examples after A1.

**Revision:** E3 phase 1: `project list|get|create|delete` + one transcript edit example in docs/`ops schema`. Defer full segment CRUD aliases until account smoke proves access. Keep “not a confirmed replacement” in CLI help, not only docs.

---

### 7. Medium — Music alias expansion partly redundant with D1 + `call`

**Plan:** D2 six new music subcommands
**Code:** `aliases/music.ts` only `generate` / `stream_compose`; budget already treats `compose_*` as music.

**Failure:** After A1+D1, `elv call compose_detailed_stream` works with SSE files. Building `detailed`, `plan`, `upload`, `stems`, `from-video` duplicates flags and freezes schemas the plan itself says are evolving (`--json` only).

**Revision:** Ship only `music detailed-stream` (the SSE ergonomics gap) plus optional `music plan`. Point other flows at `call`/`ops schema` until call volume justifies aliases.

---

### 8. Medium — Service-account / workspace risk wording is slightly wrong

**Plan:** C3 “`create_service_account`: `external_side_effect` via existing service-account policy”
**Code:** `risk.ts` — ID not in `EXTERNAL_SIDE_EFFECT_OP_IDS`, but pattern `/service_?account/u` matches — so classification works today.

**Failure:** Future rename of patterns or compiler order could drop it; plan implies explicit ID override. Create may already return secrets (not only “future schema”).

**Revision:** Add explicit op IDs for `create_service_account` (and new dubbing deletes if not method-derived). G1: treat create response as secret-capable **now** (spill policy if any credential-shaped field appears).

---

### 9. Medium — Spec provenance / trust gaps left open

**Plan:** A1–A2 honor `ELV_SPEC_URL`; timeout
**Baseline gaps:** cache keyed by package version not digest; no size limit; untrusted URL can replace active cache.

**Failure:** Compromised or mistaken `ELV_SPEC_URL` installs a valid OpenAPI with attacker hosts only if servers follow `servers` (CLI may ignore servers — lower impact) or oversized JSON DoS. Agents run `spec update` in CI without pinning.

**Revision:** A2/A3: record sha256 in runtime cache envelope; `update` without `--from` uses pin or requires explicit confirm for unpinned live fetch in prod profiles; max download bytes; `--offline` default in CI docs.

---

### 10. Medium — Agent ergonomics: secret files + `capabilities` vs long-tail truth

**Plan:** B1 capabilities; G2 file-only secrets; Product contract #1–12
**agentfit:** avoid mega surfaces; teach next command.

**Failures:**

1. Hints say “read file when needed” without a safe one-liner agents actually use (`view` redacts).
2. Capabilities claiming “338 operations / full REST” without “at pin hash / refresh via spec” invites stale offline claims after upstream moves (residual limits partially cover this).
3. Baseline P1 `wait` profile/base-url propagation still absent from plan — agents polling dubs with wrong profile still break.

**Revision:** G2 hints: exact OS-level or `elv view --raw-file` contract. Capabilities envelope must include `spec.sha256` + `stale_warning` if active ≠ vendored. Add small H/wait note or explicitly residual-limit standalone `wait` config.

---

### 11. Low — “Full API” language is mostly disciplined, still fragile in acceptance

**Plan:** Decision (good exclusion of ElevenCreative); Product #6; Acceptance “every current official REST operation”; Workstream I
**Research:** OpenAPI ≠ entire product surface; WS/AsyncAPI separate.

**Failure:** README/skill still say ~320 “any operation”; after ship, marketing may collapse to “full API” without pin date. Acceptance “every current official REST” without “pinned snapshot SHA” is time-unbounded.

**Revision:** Pin wording: “full **published OpenAPI at SHA …** + documented client WS catalog; not ElevenCreative UI.” Acceptance must check hash + counts, not “current” alone.

---

### 12. Low — Process: Checkpoint 1 gates on external reviews that are only prompts

**Plan:** Checkpoint 1 gate “plan incorporates both external reviews”
**Files:** `docs/reviews/plan-review-*-prompt.md` are prompts, not review outputs.

**Failure:** Gate cannot be met until this review (and Claude’s) are folded.

**Revision:** Gate on “r2 incorporates Grok+Claude findings” with a short disposition table in the plan revision history.

---

## What the plan gets right (do not regress)

- Rejects one alias per op; keeps `call` as long tail.
- Honest ElevenCreative / Speech Engine upstream exclusions.
- Correct diagnosis of HTTP metadata strip, non-transactional `updateSpecCache`, SSE-as-text, WS flag false advertising, simulation deprecation, secret/token tension.
- C3 explicit RAG POST-as-read and no invented dubbing credit rates.
- Wave ordering: contract → transport/secrets → aliases → WS/docs.
- No paid generation in CI.

---

## Verdict

### **Approve with revisions**

Do not execute Waves 1–4 until Critical #1–2 and High #3–5 are written into the plan (or explicitly residual-limited with matching acceptance demotion). Medium #6–7 should shrink Wave 3 before implementation to protect schedule.

**Minimum r2 patch list:**

1. True pair-atomic cache + crash tests
2. Secret field set + save-json/view policy
3. Honest / fail-closed budget matrix for generate, matched HTTP, WS
4. STT/agent WS claim split or F6 binary/script work
5. Full HTTP card inheritance + deterministic match
6. Slim E3/D2 alias set
7. Pin-hash wording in acceptance and docs claims

---

## Delegate completion report

| Field | Value |
| --- | --- |
| **Status** | completed |
| **What I did** | Read-only adversarial product/security review of the expansion plan against research docs and live source seams (HTTP, fetch-spec, budget, redaction, WS). |
| **Files changed** | none (safe mode) |
| **Files reviewed** | `docs/plans/2026-07-16-elevenlabs-api-expansion.md`; `docs/research/{elevenlabs-api,openapi-spec-drift,cli-coverage-baseline}.md`; key `src/**` listed above; skills `plan-review-loop`, `planning-workflow`, `elv`, `agentfit` |
| **Verification** | Code/doc inspection only; no build/test/network (per review brief) |
| **Remaining risks / follow-ups** | Parent should fold Critical/High into plan r2 before implementation; Claude architecture lane may add non-overlapping findings — triage convergence before Wave 1. |
