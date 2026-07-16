=== completionReport ===
I'll do a read-only final regression pass: first load any review-relevant skills, then inspect the `a9de3c2..HEAD` diff, prior reviews, and release surfaces under the five-minute cap.Prior reviews and the latest fix commits next — focusing on security, secrets, budgets, streaming, and validation.Re-checking R1–R4 fix sites and scanning security, secrets, and packaging surfaces.## Skills applied

| Skill / contract | Use |
| --- | --- |
| **delegate-agent** | Safe/read-only mode; no mutations; evidence over speculation |
| **elv / AGENTS.md** | Envelope, exit codes, dry-run, `--yes`, budget, secrets, WS catalog |
| **agentfit** (contract lens) | Discovery honesty, gate pedagogy, false coverage |
| Others | Not load-bearing for this RC pass |

**Mode:** read-only. No edits, installs, or global `elv`. Evidence from `a9de3c2..HEAD` source, prior review reports, tests, and bounded Node probes.

**HEAD:** `4561ba1` — *fix(review): restore polymorphic request validation*

---

# Round 5: final regression review

## Finding 1 — MEDIUM: vendored OpenAPI path resolution breaks under spaces / encoded install paths

**Evidence**

`src/openapi/registry.ts` resolves package-relative files via `URL.pathname`:

```194:207:src/openapi/registry.ts
function vendoredSpecCandidates(): string[] {
  return [
    resolve(new URL("../../spec/openapi.snapshot.json", import.meta.url).pathname),
    resolve(new URL("../spec/openapi.snapshot.json", import.meta.url).pathname),
    resolve("spec/openapi.snapshot.json"),
  ];
}
```

Same pattern for meta + `package.json`. Contrast `src/cli.ts`, which uses `fileURLToPath` / `URL` correctly for entry detection and can `readFileSync(packageUrl)`.

**Verified probe** (Node): for a package under a directory with spaces,  
`new URL("../spec/...", import.meta.url).pathname` yields a path containing literal `%20`; `existsSync` is **false**.  
`fileURLToPath(...)` yields the real path; `existsSync` is **true**.

**Failing invariant**

Published layout (`package.json` `files` includes `spec/openapi.snapshot.json` next to `dist/`) must resolve when `import.meta.url` is `…/dist/cli.js`, including installs under paths with spaces. Cold start with no cache then falls through to CWD `spec/…` and fails outside the package root.

**Reproduction**

```bash
# install or unpack package under a path with a space, then from another cwd:
node /path/with spaces/node_modules/eleven-agent-cli/dist/cli.js spec status --offline
# expected: loads vendored snapshot; with pathname bug: missing file / recompile from missing CWD path
```

**Smallest fix**

```ts
import { fileURLToPath } from "node:url";
// ...
fileURLToPath(new URL("../spec/openapi.snapshot.json", import.meta.url))
```

for all package-relative candidates (spec, meta, package.json). Add one test with a temp dir whose name contains a space.

---

## Finding 2 — LOW: plan C4 “HTTP inherits Music SSE” is under-tested (false confidence, not a product miss)

**Evidence**

Plan C4: *Prove matched raw Music detailed streaming inherits SSE handling.*

`tests/commands/http-metadata-budget.test.ts` “inherits Music generation metadata…” mocks:

```ts
streamKind: "text"  // not "sse_events"
```

and only asserts **budget** (`code: "budget"`, `credits_estimated: 4500`). It does not exercise `normalizeResponse` SSE via `runHttp`.

Real compile/registry surface is correct:

- snapshot: `compose_detailed_stream` → `text/event-stream` + `x-fern-streaming: true`
- `tests/openapi/openapi-registry.test.ts` asserts `streamKind: "sse_events"`
- `tests/core/sse-events-expansion.test.ts` covers the SSE normalizer

HTTP matching spreads full registry ops (`…registryOp`), so production behavior should inherit `sse_events`. The gap is the HTTP integration claim, not the compiler.

**Smallest fix**

In the HTTP test, set `streamKind: "sse_events"` and either mock a tiny SSE body through `runHttp` or assert matched dry-run/live warning + that the prepared op’s `streamKind` is `sse_events`.

---

## R1–R4 recheck (must-fix items)

| Round / item | Status | Evidence |
| --- | --- | --- |
| R1 `spec update --dry-run` cache write | **Fixed** | `src/cli.ts` uses `mergedOptions(command).dryRun` |
| R1 `extractJsonObjects` escape | **Fixed** | `char === "\\"`; probe with escaped quotes/`{}` parses |
| R1 RAG risk `read` | **Fixed** | `READ_OP_IDS` includes `query_agent_knowledge_base_rag_route` |
| R1 deprecation on invoke | **Fixed** | `runPreparedOperation` adds `deprecated_operation` |
| R1 doc count pin | **Fixed** | `tests/openapi/docs-coverage-counts.test.ts` |
| R2 `//evil` auth exfil | **Fixed** | HTTP rejects `//`; `requestUrl` / `wsUrlFromPath` origin/host checks |
| R2 raw WS `--yes` bypass | **Fixed** | `catalogEntryForRawPath` + tests for monitor raw path |
| R2 raw WS STT budget | **Fixed** | test “inherits realtime STT budget gates for … raw paths” |
| R3 `json_events` partial preserve | **Fixed** | catch → `partial: true` files, no abort when data written |
| R3 WS partial + connect timeout | **Fixed** | `preserveFailedSession`, `WsConnectTimeoutError`, 20s default |
| R4 polymorphic body Ajv | **Fixed** | `absoluteDocumentRefs`; tests dry-run `agents tests create` + `create_auth_connection` |
| R4 schema error not exit 7 | **Fixed** | `schema_resolution_error` → exit **8** (`ProviderError`), hints present |
| R4 alias `cmd` pedagogy | **Fixed** | `aliasRunOpts` sets `cmd: commandName(command)` |
| Snapshot hash/counts | **Match** | sha256 `de047661…c844ce`; 268 / 339 / 338 / 1 / 1345 |

---

## Material suspicions disproved

| Suspicion | Result |
| --- | --- |
| Polymorphic anyOf still broken after R4 | **Disproved** — ref rewrite + dry-run tests for agent-test create and auth connection; all 7 inline polymorphic bodies share the same shape |
| Protocol-relative / host rebinding still leaks key | **Disproved** — `//` rejected; origin/host checks throw; `//evil` and `/\\evil` resolve off-origin and are blocked before send |
| Raw WS still bypasses `--yes` / STT budget | **Disproved** — catalog match on path templates; tests cover monitor and STT raw paths |
| Paid stream partials still deleted | **Disproved** — JSON events + WS preserve partial files |
| `spec update --dry-run` still writes | **Disproved** — uses `mergedOptions` |
| Snapshot/docs count drift | **Disproved** — hash match; docs pin test for 339/338 |
| Secret results inline / weak modes | **Disproved** — curated secret ops + credential-shape spill, 0600, `view` refusal tested |
| Packaging omits snapshot | **Disproved** — `package.json` `files` includes both snapshot artifacts |
| Monitor budget fail-closed required | **Disproved as contract hole** — docs fail closed for **STT/agent** sessions; monitor is protocol `monitor`, gated by `--yes` for outbound (credit fail-closed not claimed) |

---

## Verdict: **approve with fixes**

Ship-blocking R1–R4 regressions look fixed in source and regression tests. The only **verified** residual product defect worth fixing before publish is **Finding 1** (vendored path via `.pathname`). Finding 2 is test honesty only.

I did **not** run the vitest suite (no in-tree `node_modules`; prompt forbids install / global `elv`). Coordinator should still run `npm test` / typecheck / lint on a normal tree before tag.

---

## Delegate completion report

- **Status:** completed  
- **What I did / found:** Final RC read-only review of `a9de3c2..HEAD` through `4561ba1`. Rechecked R1–R4 must-fixes (security, streaming partials, dry-run, polymorphic Ajv, alias `cmd`). One remaining medium packaging path bug; one low false-confidence HTTP SSE test. No critical open regressions found.  
- **Files reviewed:** plan + research + R1–R4 reviews; `src/openapi/*`, `src/core/{client,request-builder,response-normalizer,redaction,budget,errors,files,envelope}`, `src/commands/{http,ws,cli,aliases,capabilities,spec}`, `src/ws/*`, key tests, `package.json`, `spec/openapi.snapshot*`, AGENTS/README/docs/skill  
- **Verification:** static inspection + Node probes (URL origin, JSON escape, snapshot hash, polymorphic op inventory, pathname/space packaging). No vitest / no `elv` binary.  
- **Remaining risks:** full suite not re-run here; Finding 1 unfixed until publish path includes spaces; HTTP→SSE inheritance not integration-tested end-to-end.
