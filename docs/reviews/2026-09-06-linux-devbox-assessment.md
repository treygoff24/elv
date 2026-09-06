# Linux/devbox assessment

Date: 2026-09-06. Checkout: `518f386`. Assessment: `elv-uve`.

Three native `gpt-5.6-sol` subagents, all at medium reasoning, reviewed runtime,
Linux integration, and development workflow. No Astra subagents were used.
The coordinator checked the cited source, measured the installed runtime, and
reproduced the polling deadline defect. This report recommends changes; it
does not implement them.

## Baseline

The devbox runs Linux x86_64, Node 26.5.0 and npm 11.17.0. It exposes 24 CPUs,
has no cgroup CPU quota, and has a 64 GiB memory limit with no swap. This is a
shared machine; available cores are not a reason to give every test run all of
them. No saturation was observed during this assessment.

The installed `elv` reports 0.4.0. Its built CLI is byte-identical to the
checkout's `dist/cli.js`. All 30 installed-runtime smoke cases passed through
the estate shim. The offline doctor passed its local checks; provider auth and
credits were not probed. No provider calls, generation, installations, releases,
or source changes were made. Existing worktrees were preserved.

## Fix first

### 1. Require trust before cwd config can redirect credentials

Implicit `.elv/config.json` in the current directory takes precedence over user
config and can select both `base_url` and `api_key_env`. The client then attaches
the selected key to that origin. The estate shim supplies credentials even when
the calling agent has no ambient provider key.

Sol proved this with the direct installed binary, an isolated temporary cwd,
a synthetic key, and a localhost server. `models list` returned success, and
the server received `GET /v1/models` with the synthetic `xi-api-key`. No real
credential was used. This is a conditional exposure when an agent runs the CLI
inside a checkout whose config it has not trusted, not evidence of a past leak.

Allow implicit project config to set ordinary workflow options, but require
trusted user configuration or an explicit opt-in for endpoint/key selection.
Preserve intentional custom endpoints, including explicit `ELV_CONFIG` use.
Tests must cover both rejected implicit redirects and allowed explicit ones.

Evidence: `src/core/config.ts:124-144,196-218`, `src/core/client.ts:183-187`,
`src/core/request-builder.ts:90-107`. Medium effort. Bug: `elv-tki`.

### 2. Make polling deadlines constrain the child

`wait --cmd` awaits each child without a deadline. A successful result is accepted
before the polling loop checks elapsed time. The coordinator reproduced this
offline: a child reporting success after 400 ms returned exit 0 after 498 ms
despite `--timeout-ms 50`.

Pass the remaining deadline into child execution, reject late success, and
clean up only the owned child processes on timeout or termination. Add tests for
a stalled child, late success, and signal handling. Orphan behavior was not
experimentally tested in this assessment.

Evidence: `src/core/wait-operation.ts:90-123,130-138,330-350`.
Medium effort. Bug: `elv-dcf`.

## Highest-return devbox improvements

### 3. Keep the installed binary and active skill in sync

The repo and installed-package skills match, but the active skill at
`~/.agents/skill-library/elv/SKILL.md` still advertises the removed `rtc` command.
Its `references/agents-workspace-ws.md:52-64` also teaches that workflow.

Use the existing skill propagation workflow to repair this drift, then add a
parity check to local install verification. Compare the full skill tree, not
just its entrypoint. Correct `AGENTS.md:24`: rebuilding updates a linked install,
but this devbox's packed global install needs the separate pack/install step
already documented in `STATE.md`.

Low effort for the drift repair; a checked install helper is a separate,
medium-effort improvement. Neither installation nor skill sync was performed.

### 4. Stop recompiling the spec for a status command

`spec status` calls `compileVendored`, which reads, parses, and compiles the
whole snapshot just to report provenance and counts. The shipped metadata
already contains these fields. A coordinator probe of the direct installed
command took 0.40 s with 118.3 MiB peak RSS, consistent with Sol's three runs.

Read validated metadata and verify its snapshot hash instead of recompiling.
Define a safe fallback for stale metadata and test it. This is the clearest
small, repo-local performance improvement found in the review.

Evidence: `src/openapi/fetch-spec.ts:126-142,180-192,407-437`. Low effort.

### 5. Remove unnecessary credential-launcher work from local discovery

Warm end-to-end timings, eight runs per command after one discarded warmup:

| Command | Direct installed CLI | Through estate shim |
| --- | ---: | ---: |
| `--version` | 71.6 ms | 132.8 ms |
| `config get` | 72.1 ms | 137.1 ms |
| `ops get text_to_speech_full` | 98.2 ms | 167.3 ms |

The launcher adds about 60-70 ms here. A narrowly specified keyless path for
local discovery could avoid much of that overhead. Keep unknown commands and
all network-capable forms brokered. Do not solve latency by broadly bypassing
the broker or caching credentials in a new daemon. Any shell allowlist needs
tests for flag order, explicit endpoints, and unexpected arguments.

The same integration exposes a smoke-test assumption: `scripts/smoke.sh:18-24`
unsets the API key, but its `ELV_BIN` can be a shim that injects it again. Every
current row was inspected and is offline. Future safety should be enforced by
a no-egress test environment and a synthetic credential-injecting canary, not
by claiming that an unset variable guarantees no network access.

Medium effort across the CLI and estate tooling. Measurements show the present
cost, not a measured speedup from an unimplemented change.

### 6. Bound large-result inspection memory

`view --limit 1` reads and parses the whole file before selecting output.
Single-run synthetic NDJSON probes on the installed binary measured:

| Input size, approximate | Peak RSS | Elapsed |
| --- | ---: | ---: |
| 1 MiB | 63.3 MiB | 0.09 s |
| 32 MiB | 165.3 MiB | 0.16 s |

Start with incremental NDJSON parsing and retain only the selected output.
The existing whole-file credential refusal is essential: scan through EOF
before emitting an envelope, even if the requested first row is already known.
This bounds memory, not total scan time. General JSON streaming is a separate
decision and should not bring in a large parser dependency without evidence.

Evidence: `src/commands/view.ts:21-60,80-94,139-146`. Medium effort. Validate
large-file RSS and a credential appearing after the selected rows.

### 7. Make development checks considerate of the shared machine

`vitest.config.ts:3-10` has no worker ceiling. Benchmark two and four workers
before choosing an environment-overridable local default. There is no evidence
yet that either setting makes this suite faster; the immediate benefit is a
predictable resource budget.

The bin-symlink test also runs a second build inside the test suite
(`tests/integration/bin-symlink.test.ts:43-45`), after the gate already built.
Move that assertion into post-build artifact verification or build into an
isolated target. Do not remove its coverage of installed-bin behavior.

CI already covers Linux and macOS on Node 22. Add a Linux Node 26 lane to test
the actual devbox runtime continuously. The README's prior Linux 22/26
verification claim is not proof of ongoing CI coverage.

Low-to-medium effort. Keep the explicit test glob that excludes agent worktrees.

## Smaller follow-ups

- Return one registry snapshot per command. `src/core/client.ts:73-74` loads the
  registry and then reads its cache again. Each read parses and fingerprints
  the roughly 2.9 MB cache. Avoid duplicate work before introducing a split
  index/schema format or more cache invalidation machinery.
- Stream `--all` collection output rather than accumulating every page in
  `src/core/pagination.ts:158-194`. Preserve file publication, credential checks,
  cursor limits, and error behavior. This matters most for large inventories;
  no real account-scale benchmark was run.
- Dispose of retry response bodies before backoff in `src/core/retries.ts:49-54`.
  The current code does not explicitly consume or cancel them. Validate with
  instrumented response streams; connection exhaustion was not reproduced.
- Honor absolute `XDG_CONFIG_HOME` and `XDG_CACHE_HOME`, with `ELV_*` overrides
  retaining precedence and existing HOME paths as fallback. Defaults currently
  hard-code HOME paths in `src/core/config.ts:124-130,209-215` and
  `src/openapi/registry.ts:169-171`. Decide migration compatibility explicitly.
- Keep durable output out of a disposable cache directory by using an explicit
  per-job output directory. The current default is `~/.cache/elv/out`; no files
  should be moved automatically.
- Strengthen packed-artifact verification. `scripts/pack-smoke.sh` borrows all
  repo dependencies and changes the entrypoint mode before running it, so it
  cannot prove production-dependency completeness or original archive modes.
  Inspect unique archive entries and add a production-only install check.

## Keep

Native file-backed multipart uploads already avoid whole-file buffering.
Ordinary binary downloads stream to disk. Output publication protects existing
files, and registry updates use unique temporary files plus atomic rename.
Headless file output is appropriate for this devbox. Keep the JSON-envelope,
credential-file, confirmation, and budget contracts intact.

Do not start with a Rust rewrite, a daemon, additional native audio dependencies,
or restoration of the intentionally removed WebRTC/Speech Engine surfaces.
The concrete trust, deadline, and integration fixes come first.
