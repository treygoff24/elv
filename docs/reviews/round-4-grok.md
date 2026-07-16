=== completionReport ===
I'll do a read-only agent-ergonomics review: first load the relevant CLI skills, then inspect the post-R1–R3 workspace, plan, docs, tests, and bounded CLI probes.Skills loaded (agentfit, agent-ergonomics audit-only, elv contract). Next I'll inspect the plan, prior review findings, and run bounded CLI probes.No local `node_modules`/`dist` — sticking to static inspection and tests. Probing high-risk agent surfaces next.Global `elv` looks current. I'll run bounded probes against the workspace source using the nearby package's existing dependencies.Two serious signals: corrupt `ops list --limit 500` output and `agents tests create --dry-run` schema failure. Verifying both carefully.## Skills applied
| Skill | Role |
| --- | --- |
| **agentfit** | Envelope, exit codes, discovery, dry-run, actionable errors, determinism |
| **agent-ergonomics** (audit-only) | First-try success, intent recovery, self-docs |
| **elv** | Published agent contract |
| Others | Not needed for this lens |

**Mode:** Delegate Grok **safe / read-only**. No file mutations. No dependency install. Probes used the installed `elv` at the same HEAD (`bbd5c3a`) as this tree (global binary + matching `elevenlabs-cli` checkout). Workspace itself has no `node_modules`/`dist`; `tsx` failed on long IPC paths (known sandbox papercut).

**Range:** `a9de3c2..HEAD`, plan, R1–R3 reviews, docs/tests, live discovery/dry-run probes.

---

# Round 4: agent ergonomics and compatibility

## Finding 1 — HIGH: polymorphic request bodies make 7 operations (including new `agents tests create/update`) uninvokable

**Evidence**

`getInputValidator` compiles **inline** bodies with bare `#/components/...` refs. Those resolve against empty id `#`, not the registered OpenAPI document:

```16:22:src/openapi/ajv.ts
export function getInputValidator(ajv: Ajv2020, op: OperationCard): ValidateFunction | null {
  if (!op.requestBody) return null;
  if (op.requestBody.schemaRef) {
    return ajv.getSchema(`${OPENAPI_SCHEMA_BASE}${op.requestBody.schemaRef}`) ?? null;
  }
  if (op.requestBody.schema) return ajv.compile(op.requestBody.schema as AnySchema);
```

Compiler only sets `schemaRef` for a **top-level** `$ref`. `anyOf`/`oneOf` bodies store the inline schema instead:

```134:144:src/openapi/compile-spec.ts
  const schema = asObject(media).schema;
  const schemaRef = refValue(schema);
  ...
  return {
    ...
    schemaRef,
    schema: schemaRef ? undefined : schema,
```

`ops get create_agent_response_test_route` shows the broken shape (`anyOf` of three `$ref`s, no `schemaRef`). Schemas **are** present in the snapshot; discovery (`ops schema --example`) works; **invocation does not**.

**Verified failures** (`--dry-run`, no network):

| Operation | Surface |
| --- | --- |
| `create_agent_response_test_route` | `elv agents tests create`, `elv call …` |
| `update_agent_response_test_route` | `elv agents tests update`, `elv call …` |
| `create_auth_connection` | `call` only |
| `update_auth_connection` | `call` only |
| `create_phone_number_route` | `call` only |
| `create_environment_variable` | `call` only |
| `public_create_order` | `call` only |

**Reproduction**

```bash
elv agents tests create --json '{"name":"Refund"}' --dry-run
# exit 7, ok:false
# error.code=internal_error
# message: can't resolve reference #/components/schemas/CreateResponseUnitTestRequest from id #
# hints: []
```

Same for `update` with `--test-id t --json '{"name":"X"}'`.

This is the plan’s preferred replacement for deprecated `agents simulate` (`AGENTS.md` L36). Create/update are advertised in `capabilities` `alias_families.agents` but cannot be first-tried successfully.

**Smallest fix**

In `getInputValidator`, rewrite document-local `$ref` values (`#/…` → `elv://openapi#/…`) before `ajv.compile`, **or** validate polymorphic bodies via a `$ref` into a temporary schema registered on the same base as `buildAjv`. Add dry-run tests for `create_agent_response_test_route` and one other `anyOf` op.

---

## Finding 2 — MEDIUM: local schema-resolution failures use `internal_error` → exit **7** (transient) with empty hints

**Evidence**

Ajv throws into `envelopeForThrown`, which stamps `code: "internal_error"`:

```576:593:src/core/client.ts
  return failure({
    ...
    error: {
      type: "runtime_error",
      code: "internal_error",
      message: error instanceof Error ? error.message : String(error),
```

`internal_error` is in `TRANSIENT_CODES` → `ExitCode.TransientExhausted` (**7**):

```22:28:src/core/errors.ts
const TRANSIENT_CODES = new Set([
  ...
  "internal_error",
  "service_unavailable",
]);
```

**Reproduction:** command above → **exit 7**, `retry.recommended: false`, `hints: []`.

Agents that branch on exit code treat 7 as “retryable provider flakiness,” not “local CLI schema bug.” No `elv ops schema …` / fix-up hint.

**Smallest fix**

Catch Ajv missing-ref / compile failures and emit `validation_error` or `schema_resolution_error` with exit **2** or **8**, plus a hint like `elv ops schema <id> --example`. Keep `internal_error` → 7 only for true provider 5xx mapping.

---

## Finding 3 — MEDIUM: alias safety errors rewrite `cmd`/hints to `elv call …`, not the alias the agent typed

**Evidence**

`runOperation` hardcodes the command string:

```54:59:src/core/client.ts
export async function runOperation(...): Promise<Envelope> {
  const cmd = `elv call ${operationId}`;
```

Confirmation gate reuses that:

```221:225:src/core/client.ts
      confirmationRequired(cmd, `${op.operationId} (${op.risk}) requires --yes`, {
        ...
            cmd: `${cmd} --dry-run`,
```

**Reproduction**

```bash
elv workspace service-accounts create --name CI
# cmd: "elv call create_service_account"
# hints[0].cmd: "elv call create_service_account --dry-run"
# (not: elv workspace service-accounts create --name CI --dry-run)

elv dubbing-project transcript delete-segment --project-id p --segment-id s
# same pattern for dubbing_transcript_segment_delete
```

Gates still work (exit 4 / dry-run OK). Pedagogy fails agentfit “exact corrected command.” Hotter after deep new aliases (`workspace …`, `dubbing-project …`, `agents tests …`).

**Smallest fix**

Pass `cmd` from `commandName(command)` through `runAlias` / `runOperation` (optional `cmd` on `RunOpts`). Build dry-run / `--yes` hints from that string.

---

## Finding 4 — LOW: `capabilities` still frames agents as “simulation shortcuts”

**Evidence**

```24:28:src/commands/capabilities.ts
    name: "agents",
    description: "Conversational AI agent lifecycle and simulation shortcuts.",
```

Plan/docs push **tests create/run** over simulate. Description steers discovery toward the deprecated path while listing test ops underneath.

**Smallest fix:** e.g. `"Agent lifecycle, response tests, RAG query; simulate is deprecated."`

---

## Finding 5 — LOW: double deprecation warnings on `agents simulate` dry-run

**Evidence (live):** two `deprecated_operation` warnings — generic from `runPreparedOperation` and the alias-specific message. Harmless noise; not a contract break.

**Smallest fix:** drop the alias-only duplicate, or merge on `code`.

---

## Material suspicions disproved

| Suspicion | Result |
| --- | --- |
| `ops list --limit 500` truncates stdout | **Shell `$(…)` capture artifact** (~64KiB). Writing to a file: **94 486 bytes**, valid JSON, 338 items. Default `--limit 100` ≈ 28 KB. |
| R1: `spec update --dry-run` writes cache | **Fixed.** Offline dry-run → `written: false`. |
| R1: RAG risk still `mutate` | **Fixed.** `risk: "read"`. |
| R1: false `get_agent_response_tests_summaries_route` in capabilities | **Gone.** |
| Unbounded `capabilities` | **~8.6 KB**, stable key order, sorted groups/aliases/ws. |
| New parents are help dead-ends | **`workspace` / `dubbing-project` / `agents tests` exit 2** with `raw.subcommands` and a clear message (same as `voices`). |
| Profile precedence wrong vs capabilities | **Matches:** flag > env > profile > default (probed with temp `ELV_CONFIG`). |
| Non-deterministic `ops list` | **Byte-identical** across two runs. |
| New gated aliases skip `--yes` / dry-run | **Gated** (create SA, delete segment); dry-run sets `would_require_yes`. |
| `music detailed-stream` broken | **Dry-run OK** with prompt/timestamps. |
| Impossible bare parents for nested members | Exit 2 listing `list` — intentional, not a dead end. |

---

## What is solid after R1–R3

- One JSON envelope on bare CLI, `--help`, errors, parents.
- Exit dictionary mostly honored; did-you-mean for typos (`tss`→`tts`, `ops serch`→`search`).
- `ops list` filters, bounds (`limit` 1–500), deprecation metadata.
- Dry-run before yes/budget; secret-file contract still in place.
- New aliases register and map to real registry op IDs (builder + registry tests).
- Docs/AGENTS/skill prefer `scribe_v2`, Flash, `agents tests` over simulate.

---

## Verdict: **approve with fixes**

**Must fix before treating agent-test expansion as shippable:** Finding 1 (and ideally 2 with it). Findings 3–5 are smaller ergonomics cleanups.

---

## Delegate completion report

- **Status:** completed  
- **What I found:** Polymorphic OpenAPI bodies break Ajv (`#/` refs compiled without `elv://openapi` base), so **7 ops including `agents tests create/update` fail on dry-run/call** with exit 7 and empty hints. Alias confirmation/`cmd` surfaces lose the typed alias path. Minor capabilities copy + double-deprecation noise. R1–R3 security/streaming/dry-run issues look fixed on probed surfaces.  
- **Files reviewed:** `src/openapi/ajv.ts`, `compile-spec.ts`, `client.ts`, `errors.ts`, `capabilities.ts`, alias modules (`agents`, `workspace`, `dubbing-project`, `music`), `cli.ts`, `ops.ts`, plan + R1–R3 reviews, expansion tests, AGENTS/README/skill.  
- **Verification:** Read-only source + live `elv` probes at HEAD `bbd5c3a` (capabilities, ops list/get, parent bare commands, dry-runs, confirmation gates, profile precedence, 7 polymorphic ops). No vitest run (no in-tree `node_modules`; tsx IPC broken in this sandbox).  
- **Remaining risks:** Any other inline body schema with nested `#/` refs shares F1; agents that auto-retry exit 7 will loop on F1; full suite not re-run here.
