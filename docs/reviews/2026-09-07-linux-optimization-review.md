# Linux optimization review and fix batch

Implementation candidate: `7a97cd3`, against baseline `47b8710`.
Status: complete. CLI and launcher fixes are reviewed, verified, and installed;
the active skill matches the installed package. Npm publication remains held.

Six Claude Opus 5 high-effort Delegate lanes implemented the candidate. The
coordinator integrated it and ran the gate: 843 tests passed, 3 live-API tests
skipped, and 30 smoke cases passed. Packed production-only installation smoke
also passed. Those results do not invalidate the defects below.

Reviewers: Claude Opus 5 high for core correctness, GLM 5.3 high for the spec,
and Grok 4.6 high for tooling/safety, plus coordinator source checks and
synthetic probes. A Qwen 3.8 Max review was rejected because several claimed
missing implementations were visibly present. No provider calls or real keys
were used in the probes.

## Accepted findings

### C1. Trust errors give an ineffective remedy

`src/core/config.ts` rejects privileged cwd fields before applying overrides,
but suggests passing `--base-url` as an alternative. That alone still fails.
Keep the whole-file refusal; say to remove the fields before using the flag,
or explicitly trust the file with `ELV_CONFIG`. Quote generated shell paths.
Use distinct trust/missing-file error codes instead of `config_json_invalid`.
Test the advice and secret-free diagnostics. Coordinator finding.

### C2. XDG config selection differs across the estate launcher

The broker clears `XDG_CONFIG_HOME`; the new local fast path retains it.
Preserve the caller's explicit XDG config selection for elv after the broker
has resolved credentials, without weakening clean-exec controls, required-key
validation, or other engines' auth-root scrubbing. Test both paths with fake
HOME/config/realm credentials. Keep unknown argv forms brokered.

The shared main shim is concurrently owned by the Exa task. Apply this fix to
the isolated elv candidate first; the coordinator will merge it additively
after the Exa handoff. Do not edit `estate-agent-tool` or overwrite Exa changes.

### C3. Retry-body time budget resets on every chunk

`src/core/retries.ts` gives each read the full timeout. Coordinator probe:
eight one-byte chunks 15 ms apart took 124 ms with a 30 ms body budget.
Use one total deadline for classifying a discarded response and bound cleanup.
Test a slow-drip stream, not just one that sends nothing. Final responses must
remain readable by the caller.

### C4. Raw HTTP still reads the registry twice

`src/commands/http.ts` loads operations in `httpOperation`, then reads the
cache again for schema validation. Reuse one snapshot and add a one-read
regression while preserving known-path safety/schema handling. Update
capabilities' environment discovery for the new XDG variables. Coordinator.

### C5. First HTTP poll can exceed the overall deadline indefinitely

`src/core/wait-operation.ts` deliberately awaits the first operation poll
without a deadline; later polls are abandoned without cancelling the request.
Coordinator probe: a 100 ms first poll returned after 102 ms despite a 10 ms
budget. Both Opus and GLM confirmed the missing cancellation path.

Thread an `AbortSignal` through `RunOpts`, the client, retries/fetch, and custom
alias wait runners. Enforce the deadline from the first poll and do not retry
cancelled work. Preserve created job IDs and re-poll hints, but never invent an
unobserved status. Test a local HTTP server that accepts and never responds;
verify it observes request cancellation. Replace the test that encodes the
unbounded first poll with the correct deadline contract.

### C6. NDJSON numeric-index array projection regressed

`src/commands/view.ts` only recognizes a bare numeric head or standalone `[]`.
Existing `readPath` also supports `0[].name` when row zero is an array.
Coordinator probe expected `["a","b"]` and got `path not found`.
Preserve numeric-suffix projections, nested grouping, missing-row behavior,
and full credential/malformed-input scanning. Add parity cases.

### C7. NDJSON summary memory still grows with row count

`ArrayAccumulator.summaryShape()` extends an array to the full row count just
to derive a summary and hint. Extending a one-item array to one million slots
allocated 7.63 MiB in the coordinator's V8 probe. Summarize the retained prefix
and set the true count explicitly instead. Add a count-scaling regression.
Remove the false comment that a JSON spill threshold caps input size.

### C8. Node no-egress misses DNS entry points

After loading `scripts/no-egress.mjs`, the named `resolve4` exports from both
`node:dns` and `node:dns/promises` still differ from the guarded defaults.
`resolveSoa` and other resolver methods are omitted too. The coordinator
verified these identities without sending DNS traffic.

Synchronize builtin ESM bindings where required and cover the promised DNS
entry points, including Resolver variants. Test named imports and omitted
methods with synthetic interception. Do not accidentally send external DNS
queries for a permitted localhost name. Keep the documented limitation: this
is a Node transport guard, not an OS sandbox for arbitrary subprocesses.

### C9. Skill sync can overwrite a file outside its target

`scripts/install-verify.mjs` treats failed Git inspection as a clean tree,
skips symlinks in its manifest, then follows destination symlinks when copying.
An isolated non-Git fixture with `SKILL.md` pointing to an outside canary was
overwritten without `--force-skill`. Grok independently found this path.

Validate the selected root and child paths; do not follow symlink escapes.
Fail closed on unknown existing-target dirty state. Use a Git pathspec and
NUL-delimited status rather than prefix-parsing quoted paths. Add durable
tests for dirty files, nested skill directories, renames, non-Git targets,
file/directory symlinks, and extra symlink drift. Never delete foreign files.

### C10. Interrupted waits recommend retry; chunk decoding corrupts UTF8

Set `wait_interrupted.retry.recommended` to false. Use a `StringDecoder` per
child stream while retaining byte caps. A coordinator child split an e-acute
code point across two writes; the result was two replacement characters with
`ok:true`. Test that split and the interrupt advice. Reject truncated stdout
as a complete envelope even if its prefix happens to parse. Opus/coordinator.

### C11. Process-group cleanup depends on a living leader

`signalOwned` returns early once the leader exits, and settlement cancels
escalation when the leader closes. A finite coordinator fixture left its
grandchild alive after `wait_timeout`; only that recorded fixture PID was
subsequently cleaned up.

Track and clean the owned process group independently of the leader. Cover
early leader exit and a grandchild that ignores SIGTERM. Finish escalation
before declaring cleanup complete; retain PID/group-identity safeguards and
never signal unrelated processes.

### C12. Project config can erase a trusted budget ceiling

An implicit project file replaces user config wholesale. Coordinator probe:
a trusted ceiling of 5 became absent when the project only set `output_dir`.
Preserve trusted ceilings; project settings may only lower them. Explicit
user flags/env overrides remain intentional authority. A project profile
must not select another trusted credential profile or endpoint.

Test missing, raised, lowered and invalid project ceilings and profile
selection. Update precedence documentation. Project output folders remain
allowed, as explicitly approved; do not expand the ban to `output_dir`.
Opus finding, verified by the coordinator.

### C13. Snapshot invalidation test does not change its source

The test named "still recompiles a source that changed under a forced
snapshot" recompiles the same fixture and asserts an unchanged fingerprint.
Mutate a temporary source, then assert fingerprint/operation changes for
normal and forced invalidation. Opus finding.

While fixing nearby code, make unused exported wait internals private and
prefer native cancellation over duplicate interrupt machinery where it reduces
complexity. Retaining a nullable injected-cache test seam is acceptable; do
not grow dummy fixtures just to satisfy a cosmetic type preference.

### C14. Install verification needs the same safeguards as pack smoke

Add `--ignore-scripts` to offline installation. Verify the bin resolves to the
expected matching artifact before executing it; a wrong target is drift, not
a note followed by execution. Apply the Node guard to capabilities, with a
disposable registry cache. Add installer regression tests.

Quote path-bearing suggestions and name only copied files in suggested Git
commands. Verify after sync so the final result describes current state.
Use literal exact matching for the tar entry, not an unanchored regex.
Grok findings and coordinator source checks.

## Rejected or already-resolved suggestions

- The early Opus core review could not see the later docs lane. XDG/output
  and linked-versus-packed documentation is now present; recheck final drift.
- Forbidding project output folders contradicts the approved behavior. Keep
  restrictive sensitive-file modes and deliberate, named-file Git staging.
- GLM suggested disposing final responses before returning them. That would
  destroy bodies the caller must read; only discarded responses are disposed.
- Alias timing values already propagate through the existing timing spread.
  The actual missing propagation is cancellation, covered by C5.
- Refusing the non-Node estate wrapper in smoke would remove the requested
  PATH verification. The actual broker reads local credentials and the final
  Node process inherits the guard. Arbitrary wrapper egress is not covered.
- Static allowlist maintenance and memory proportional to one largest JSON
  record remain documented limitations, not reasons to add a daemon/parser
  framework. All accepted defects above still require fixes and verification.

## Single-fixer resolutions, 2026-09-07

C1 through C14 are implemented, pending the parent's independent review and
full release/install checks. No project commit, installation, provider call,
active-skill sync, or live linux-devbox edit was made by the fixer.

| Finding | Resolution and changed files |
| --- | --- |
| C1 | Whole-file trust refusal, quoted actionable advice, distinct trust/missing codes, and secret-free parse errors. `src/core/config.ts`, `src/core/errors.ts`, `src/core/client.ts`, `src/cli.ts`, `src/commands/ws.ts`; `tests/core/config-trust.test.ts`. |
| C2 | Elv-only XDG restoration after broker key resolution; clean-exec and explicit key requirements remain brokered. Candidate-only `40-cells/user-env/estate-cli-shim`, `tests/estate-elv-offline.test.sh`, `tests/estate-launchers-portability.test.sh`, `README.md`. The candidate path remains the one in the fix brief. |
| C3 | One body-read deadline and bounded cancellation; final response bodies remain readable. `src/core/retries.ts`; `tests/core/runner-retries.test.ts`. |
| C4 | Raw HTTP shares one operation/schema snapshot; capabilities list XDG variables. `src/commands/http.ts`, `src/commands/capabilities.ts`; `tests/openapi/registry-snapshot.test.ts`. |
| C5 | AbortSignal reaches fetch and retry backoff from the first poll, including aliases. `src/core/types.ts`, `src/core/client.ts`, `src/core/retries.ts`, `src/core/wait-operation.ts`, `src/commands/aliases/shared.ts`; `tests/core/wait-http-cancellation.test.ts`, `tests/core/wait-child-deadline.test.ts`, `tests/core/wait-profile-propagation.test.ts`, `tests/commands/flows-assets.test.ts`, `tests/commands/stt-wait.test.ts`. The STT timeout fixture now permits one observation before its polling interval exhausts the budget, retaining the exact request assertions. |
| C6 | Numeric-suffix projections retain whole-JSON parity, including nested and missing selections. `src/commands/view.ts`; `tests/commands/view-streaming.test.ts`. |
| C7 | Summaries retain only the preview and report the true count separately; a million-row regression bounds the summary input. Same files as C6. |
| C8 | DNS methods, Resolver variants, and named ESM exports are guarded. Local lookup names become literals; packet-emitting resolve/reverse methods require explicit allowlisting. `scripts/no-egress.mjs`; `tests/integration/devtools-no-egress.test.ts`. |
| C9 | Sync refuses symlink destinations and unknown/dirty/ignored target state, uses literal Git pathspecs with NUL status, and retains foreign entries. `scripts/install-verify.mjs`; `tests/integration/install-verify.test.ts`. |
| C10 | Interrupts recommend no retry; child streams use StringDecoder; truncated stdout cannot count as an envelope. `src/core/wait-operation.ts`; `tests/core/wait-child-deadline.test.ts`. |
| C11 | Owned-group cleanup survives leader exit and completes SIGKILL escalation before settlement. Cleanup timers keep the CLI alive until its envelope is emitted. Same files as C10. |
| C12 | Project settings cannot raise/erase trusted ceilings or select trusted credentials; output folders remain allowed. `src/core/config.ts`, `tests/core/config-trust.test.ts`, `README.md`, `docs/agent-setup.md`, `skills/elv/references/discovery-and-calls.md`, `src/commands/capabilities.ts`. |
| C13 | Invalidation tests mutate a temporary spec and assert changed fingerprints/operations for normal and forced loads. `tests/openapi/registry-snapshot.test.ts`. Unused wait internals are private in `src/core/wait-operation.ts`. |
| C14 | Offline installs disable scripts; unverified binaries are not executed; capabilities use the Node guard and a disposable cache; sync verifies afterward and suggests only quoted copied paths. `scripts/install-verify.mjs`, `scripts/pack-smoke.sh`, `tests/integration/install-verify.test.ts`. Tar-entry matching is literal and exact. |

Verification used `TMPDIR=/var/tmp` and at most two Vitest workers. The final
23-file focused run passed 232 tests. The added in-process HTTP cancellation
case and final config regression then passed with all 23 config tests: 234
unique focused tests across 24 files. Format check, lint, typecheck, and
ShellCheck 0.11.0 passed. Both estate suites passed, including the portability
suite against the installed broker with a fake HOME, config, and realm keys.

The initial red run reproduced seven failures covering C3, C6, and C12.
Mutation runs caught C2, C4, C5, C7, C8, C9, C10, C11, and C14 regressions.
The HTTP cancellation mutation failed while the caller process remained alive,
so that test does not confuse process exit with request cancellation. All
mutations were undone. Logs are under `/var/tmp/elv-fix-*.log` and
`/var/tmp/elv-mutation-*.log`.

The parent still owns the full gate, packed/runtime smoke, actual install and
skill sync, benchmark receipts, and additive merge with the Exa shim changes.
Windows behavior and hostile concurrent filesystem replacement were not tested.
The Node guard remains a transport guard, not an OS sandbox; process cleanup
covers the spawned process group, not descendants that create another session.
Foreign `STATE.md` changes and candidate `.beads`, `sanitize-agent-dev.py`, and
`realm-cli-rules.md` changes were left alone.

## Continuation findings and resolutions, 2026-09-07

### C15. Guard tests lacked independent network isolation

The original negative and allowlist tests depended on the guard to prevent
packets. Documentation-space addresses and immediate socket destruction did
not supply an independent boundary.

Fixed in `tests/integration/devtools-no-egress.test.ts` and the new
`tests/fixtures/synthetic-transports.mjs`. Synthetic TCP, TLS, DNS, datagram,
and fetch interceptions load before the guard through inherited NODE_OPTIONS,
including in CLI children. Tests use isolated config/cache directories and
clear inherited ELV_NO_EGRESS_ALLOW. Negative tests require the guard marker;
allowlist tests require the distinct synthetic-transport marker. Only the
separate literal-loopback positive test uses real sockets.

With those interceptions installed, replacing the guard with an empty export
produced four expected marker-assertion failures and three passes. The guard
was restored afterward. The no-guard control also verifies that CLI requests
reach only the synthetic transport.

Correction to the earlier probe summary: coordinator security probes used
local/synthetic fixtures, but the early lane guard-mutation test was not
independently network-isolated. External traffic was not observed or measured;
this does not establish that no provider requests occurred across the whole
run. No actual keys or generation were used in that probe.

### C16. Smoke preload paths broke in checkouts containing spaces

Fixed `scripts/smoke.sh` to convert the guard path with pathToFileURL and use
`--import=<file URL>`, preserving existing NODE_OPTIONS. The new bounded
`tests/integration/smoke-path.test.ts` runs the actual smoke script and all 30
matrix rows from a fixture checkout containing spaces, quotes, ampersand, and
hash. It verifies the encoded guard URL and inherited options. The fixture
uses the existing build, synthetic transports, and its own config/cache; it
performs no build, installation, or dependency resolution.

The original smoke script failed all 30 rows in this fixture. The fixed
script passed all 30.

### C17. Installer fixtures inherited symlinked temporary roots

Fixed `tests/integration/install-verify.test.ts` to canonicalize its temporary
root with realpathSync. Deliberate file, directory, and root symlink refusal
cases remain unchanged. The 14-test suite passed with both real and aliased
TMPDIR paths. Removing canonicalization reproduced three failures under the
alias; restoring it returned all 14 to green. This reproduces path semantics
on Linux, not actual macOS execution.

Continuation verification: 22 tests passed across the three changed integration
suites, plus the separate 14-test aliased-TMPDIR run. Format, lint, typecheck,
and ShellCheck passed. Red/green logs are `/var/tmp/elv-c15-isolated-mutation.log`,
`/var/tmp/elv-c15-c16-first.log`, `/var/tmp/elv-c17-alias-red.log`,
`/var/tmp/elv-c17-alias-green.log`, and `/var/tmp/elv-c15-c17-final.log`.
The parent retains full gates, installation, commits, and final narrative.

### C18. Interrupted alias polling lost created-job recovery hints

Fixed `src/core/wait-operation.ts` to retain timeoutHints on interruption,
including before the first poll returns. Retry advice remains false. Only
command-mode interruption messages mention child termination; operation-mode
messages make no such claim. Plain waits still omit hints when none were given.

Fixed `src/commands/aliases/shared.ts` to quote fallback JSON with shellArg.
Ordinary generated commands retain their existing bytes. Recovery advice now
says to check the created job instead of resubmitting, without asserting that
the provider job is still running.

The new `tests/commands/wait-recovery.test.ts` uses a synthetic creation receipt,
a synthetic first request, and simulated SIGINT. It verifies cancellation,
retained job ID/command, false retry advice, and absent child/status claims.
A POSIX shell function verifies the quoted job ID survives argument parsing;
no provider command is executed. Both tests failed before the hint fix. A
separate quote-only mutation failed shell parsing, then passed after restoration.

Verification: 29 tests passed across wait-recovery, core wait-operation,
wait-child-deadline, and stt-wait. The two new tests also passed after the
quote mutation was restored. Format, lint, typecheck, and diff checks passed.
Logs: `/var/tmp/elv-c18-red.log`, `/var/tmp/elv-c18-quote-red.log`,
`/var/tmp/elv-c18-green.log`, and `/var/tmp/elv-c18-final.log`.

Disposition of Opus's second low finding: the 250 ms grace for surviving
owned-process-group members is intentional bounded cleanup, not ordinary child
startup overhead. The parent retains the conservative full grace rather than
adding liveness polling. No process-group implementation changes were made.

## Parent gate correction

The full Node 22 gate found one stale test spy in
`tests/core/parameter-validation.test.ts`: the HTTP fixture mocked
`loadRegistry`, but C4 switched HTTP to `loadRegistrySnapshot`. Its custom
`/test` operation was therefore absent, and the expected page-size rejection
was never exercised. The parent updated only that fixture to the new snapshot
seam, retaining the validation-error and zero-fetch assertions. The red gate
had 883 passing tests, one failure, and three live-API skips; verification of
the corrected tree follows below.

The corrected test passed all 27 parameter-validation cases on Node 22. Two
other tests already mocked the snapshot correctly; their obsolete loader
spies were removed without changing assertions.

## CLI verification and installation

Both complete gates passed on Linux: Node 22.23.2 and Node 26.5.0 each ran
884 passing tests, three live-API skips, and 30 passing smoke cases. The
production-only offline pack check passed with seven runtime dependencies,
no development dependencies, original executable archive mode, and two
byte-identical 403,699-byte packs after the final skill whitespace correction.

The parent verified that no installed elv process was active and preserved a
backup before local installation. The installed CLI now matches the repo's
built bytes, SHA-256 prefix `2231dc693636e8b0`. All four skill files match
across repo, installed package, and active pool. All 22 documented command
families exist, and installed-bin smoke passed 30 cases. No npm publication,
GitHub push, or tag was performed.

Receipts are under `/var/tmp/elv-linux-opt-20260907/`:
`final-gate-node22-r2.log`, `final-gate-node26.log`, `final-pack-r2.log`, and
`final-install-verify-r2.log`. Mac CI is configured, but was not executed here.

Installed-binary canaries also passed: implicit cwd endpoint selection returned
`config_untrusted` with zero local-server requests; explicit trust sent exactly
one request with a synthetic key. A 150 ms child deadline rejected a child
scheduled to succeed after 1,200 ms, returned in 492 ms including CLI startup
and cleanup grace, and left no live child. These probes allowed only loopback
through the Node guard. Receipt: `installed-canaries.json`.

### Measured CLI changes

The same local synthetic inputs used in the assessment now show:

| Command | Before | After |
| --- | --- | --- |
| Direct `spec status` | 0.40 s / 118.3 MiB peak RSS | 0.11 s / 72.4 MiB |
| NDJSON `view --limit 1`, 1 MiB | 0.09 s / 63.3 MiB | 0.09 s / 64.3 MiB |
| NDJSON `view --limit 1`, 32 MiB | 0.16 s / 165.3 MiB | 0.14 s / 74.4 MiB |

These are single-run observations on a shared Linux devbox, not performance
guarantees. NDJSON still scans through EOF; one large record and general JSON
can still require proportional memory. Receipt: `core-performance.txt`.

## Estate integration and final close

The Exa task handed off shared files at `caf8e08`. The parent merged the elv
changes additively and committed `6abda82` in linux-devbox, preserving Exa's
physical PATH resolution, literal PATH fields, offline guard, and clean-exec
rules. Both pre-existing dirty files, `.beads/interactions.jsonl` and
`40-cells/user-env/sanitize-agent-dev.py`, remain untouched.

The combined source passed ShellCheck, elv grammar tests, Exa's dash/bash-as-sh
suite, and portability/XDG tests against both broker source and its installed
runtime. The first post-Exa-commit history scan flagged a deliberate fake-realm
key in the new Exa regression test. The parent verified its fixture origin and
added only that exact historical fingerprint to `.gitleaksignore`. No rule or
path was excluded. The complete post-commit devbox gate then passed with
ShellCheck 0.11.0 and gitleaks 8.30.1.

Only `~/.local/bin/estate-shims/elv` was installed, after backup and an idle
launcher check. It is byte-identical to the combined template, SHA-256
`e69366fdee6c88677df179be3b9f89fd4b24cd68ce3eb3c5a248766bef77be73`.
The real PATH runtime passed all 30 smoke cases. An additional fake-HOME probe
ran the actual installed CLI and launcher through the actual broker: selected
XDG config and synthetic credential presence matched the direct CLI exactly.
Exa received the final template/commit handoff for its separate installation.

Eight measured warm runs per command, after one discarded warmup:

| Command | Before, through shim | After, direct | After, through shim |
| --- | ---: | ---: | ---: |
| `--version` | 132.8 ms | 73.5 ms | 73.8 ms |
| `config get` | 137.1 ms | 74.2 ms | 139.5 ms |
| `ops get text_to_speech_full` | 167.3 ms | 98.6 ms | 102.5 ms |

Credential-sensitive config reads deliberately retain broker overhead.
These are local observations, not latency guarantees. The final RSS repeat
measured 73.8 MiB for the 32 MiB NDJSON input, consistent with the earlier run.

Receipts: `final-devbox-gate-committed.log`, `final-shim-*.log`,
`final-path-smoke.log`, `installed-xdg-canary.json`, and
`final-performance.json` under the same scratch directory. The source review
inputs were archived there before removing the temporary repo copies.

CLI commits are pushed to Forgejo main; the active skill update is `29bca5f`.
The shared launcher is pushed to `codex/elv-linux-offline-20260907`. Its local
worktree contains unrelated dirty files and origin/main advanced, so neither
was reset, stashed, or overwritten to force an in-place merge. No GitHub push,
tag, npm publication, broad estate deployment, or retained-worktree deletion
was performed. The publish decision remains `elv-w9t`.
