---
name: agentfit
description: >-
  Audit and improve how well a CLI works when an AI agent is the primary user —
  JSON envelopes, exit-code contracts, error pedagogy, intent inference, determinism,
  non-TTY discipline. Use when checking the agent-fitness of elv (or any CLI we build),
  hardening robot/JSON output, or fixing agent-hostile error messages. Ponytail-compatible:
  the smallest fix that clears the bar, ranked by leverage, no quota — zero findings is a
  valid result.
---

# agentfit — make a CLI a good fit for the agent that drives it

Point this at a CLI. It checks the surfaces an agent actually touches (commands, flags,
exit codes, errors, env vars, output) against the axioms below, ranks what's broken by
leverage, and proposes the smallest fix per finding. You approve; it applies at the root
cause and verifies with a real invocation.

This is a lens, not a pipeline. There is no scoring substrate, no persisted workspace, no
commit quota, no swarm. Re-running is cheap — the binary is the source of truth, so we
never archive a measurement to diff against.

## The one rule

The first command an agent guesses should work, or be redirected with a hint that names
the exact thing to type instead. Every axiom serves this. When intent is legible but the
invocation is wrong, infer-and-act or refuse with a copy-pasteable correction — never
silent-fail, never punish a reasonable misstep, never make the agent leave the tool to
learn the contract.

## The reference contract (elv's — the default standard)

A well-built agent CLI publishes a contract and holds to it everywhere. elv's, which is the
worked default here, is in `AGENTS.md` and enforced in `src/core/{envelope,errors,types}.ts`:

- **One envelope per command.** Stdout is always exactly one JSON object — `SuccessEnvelope`
  or `ErrorEnvelope` (`v:1`, `ok:true|false`). Including `--help`. Including errors. Including
  empty results. Binary/large output spills to disk; paths land in `files[]`.
- **Documented exit-code dictionary.** `0` success, `2` input/validation, `3` auth, `4`
  confirmation-required, `5` budget, `6` out-of-credits, `7` retryable-exhausted, `8`
  provider, `9` not-found. Branch on exit code first, parse the envelope for detail.
- **Fully non-interactive.** No prompts, no spinners, no TUI. Destructive/outbound/key/member
  ops gate behind `--yes`; reads never gate. `--dry-run` previews without the network.
- **Discovery in-tool.** `elv ops search|get|schema` and `elv config doctor` — the agent
  reads the contract from the tool, not from an out-of-band doc.

When auditing elv, you're checking **conformance to this contract** plus the universal
axioms. When auditing some other CLI, the axioms define the bar and you propose a contract
in this shape only as far as a real task needs it.

## Axioms (the checks)

Each is a yes/no an agent's life depends on. A `✗` is a finding.

1. **Stdout is data, stderr is diagnostics.** `cmd | jq .` works with no `grep -v`. Progress,
   warnings, free-text logs → stderr only. Mixing them is the #1 cause of agent fragility.
   Note the elv refinement: a *structured error envelope* is data, so it rides stdout (the
   envelope channel) with a non-zero exit — stderr stays empty. Don't false-flag that as a
   stdout/stderr violation; the violation is unstructured prose or logs on stdout. *(P0)*
2. **Never silent-fail.** Every failure produces a parseable error on the data channel AND a
   non-zero exit. A command that fails but exits 0 with empty stdout is undetectable. (elv:
   `ErrorEnvelope` on stdout, `ok:false`, exit per the dictionary.) *(P0)*
3. **Exit codes are a documented dictionary, not vibes.** Never exit 1 for "ran fine, no
   results" — that's exit 0 with an empty `[]`. The dictionary is discoverable in-tool. *(P0)*
4. **Every error names the exact fix.** Three parts: what failed, where (`file:line` / which
   arg), and the *exact* corrected command to type — copy-pasteable. "See --help" alone is a
   failure. *(P1)*
5. **Intent inference recovers legible-but-wrong invocations.** Flag/command typos
   (`--jsno`, `tts` vs `tss`), deprecated spellings, common mis-orderings → "did you mean
   `<x>`" with the corrected command, or succeed-with-warning. One typo must teach, not
   wedge. *(P1)*
6. **Structured output everywhere it's read.** Every read-side surface emits machine output
   with a stable, documented schema. For elv that's the envelope — so the check is "does
   *every* path emit it, including help, errors, and empty results." *(P1)*
7. **Self-describing.** A discovery surface exists in-tool (elv: `ops search/get/schema`,
   `config doctor`). The agent never needs an external doc to learn the contract. *(P1)*
8. **Dangerous ops gated AND a safe alternative named.** Irreversible/outbound ops require
   explicit `--yes`/`--confirm`, and the gate error names the safe path (`--dry-run`,
   `--plan`). elv's pre-flight budget gate is the same shape. *(P0 for the gate, P1 for the
   named alternative)*
9. **Deterministic output.** Same input → same bytes. No wall-clock or random IDs in stdout
   (timestamps belong in fields, honoring `SOURCE_DATE_EPOCH` where it applies). Stable
   ordering. *(P1)*
10. **Honors env + non-TTY conventions.** `NO_COLOR`, `CI`, `TERM=dumb`, non-TTY stdout all
    suppress ANSI/styling. No interactive prompt ever fires in non-TTY. *(P0 for prompts,
    P2 for ANSI leak)*
11. **No TUI / no interactive block.** Agent-first means fully non-interactive on every
    invocation, bare included. *(P0)*
12. **Round-trip economy — but only on demand.** If a *common* agent task needs 3 calls that
    could be 1, that's a finding. Do **not** add a speculative mega-command because a playbook
    says to. elv's `view` (inspect a spilled file without loading it) and the single envelope
    already carry most of this. *(P2, ponytail-gated)*

## The method

1. **Inventory the real surface.** Run the binary — `--help` walk, the discovery surface,
   a few representative commands. List the surfaces an agent touches. Fan out `Explore`
   agents *only* if the surface is too big for one read. Don't enumerate from source guesses;
   observe the binary.
2. **Check each surface against the axioms, with evidence.** Every finding cites a real
   `--help` excerpt, an invocation transcript, or `file:line`. No vibes. If a check is n/a
   for a surface, say why in one clause.
3. **Rank by leverage = severity × frequency.** Severity is the `(P0/P1/P2)` above. Frequency
   is how hot the path is — the shared envelope/error formatter that every command routes
   through outranks an obscure subcommand by a mile. Fix the shared root, not N call sites.
4. **Propose the smallest fix, then apply on approval.** One root-cause diff per finding.
   Apply where all callers route through. Verify with a real invocation (and the one-liners
   below). Show the diff. The user commits — never auto-commit, never branch unasked.

## Ponytail discipline (baked in, not bolted on)

- **Root cause, not symptom.** A bad error message in one command is usually one shared
  formatter away from fixing every command. Grep the callers before you edit.
- **No speculative surfaces.** No `--robot-triage`, no `capabilities` endpoint, no mega-command
  unless a real, common agent task demands it. The axioms are a bar to clear, not features to
  accumulate.
- **Smallest change that clears the axiom.** The first fix that satisfies the check is the
  right one.
- **No quota.** Ship the findings that clear the bar, however many that is. **Zero is a valid,
  honest result** when the CLI is already clean. Never invent work to look productive. (This
  is the deliberate inverse of the bloated audit-skill this replaces.)
- **Don't simplify away** real validation at trust boundaries, the `--yes` gates, or budget
  ceilings — those are load-bearing.

## Output format

Report findings as a ranked table, highest leverage first:

| # | Surface | Axiom | Evidence | Sev×Freq | Smallest fix |
|---|---------|-------|----------|----------|--------------|
| 1 | `elv <cmd>` | 2 silent-fail | transcript / `file:line` | P0 × hot | one-line description |

Then, after approval, a short apply log: what changed (root-cause file), the verifying
invocation, the diff. If nothing clears the bar, say so plainly and stop.

## Verification one-liners (no scripts dir — paste these)

```bash
# Stdout is pure data (parses as JSON with stderr discarded):
elv <cmd> 2>/dev/null | jq . >/dev/null && echo "stdout clean" || echo "stdout NOT clean"

# Deterministic across re-runs:
a=$(SOURCE_DATE_EPOCH=0 elv <cmd>); b=$(SOURCE_DATE_EPOCH=0 elv <cmd>); \
  [ "$a" = "$b" ] && echo deterministic || echo "NON-DETERMINISTIC"

# No ANSI leak in non-TTY:
NO_COLOR=1 CI=1 elv <cmd> 2>/dev/null | grep -qP '\x1b\[' && echo "LEAKS ANSI" || echo "no-color clean"

# Failure path is honest (non-zero exit + parseable error envelope on the data channel).
# elv puts the ErrorEnvelope on stdout — so capture stdout, not stderr:
elv <bad-cmd> >out.json 2>/dev/null; ec=$?; \
  [ "$ec" != 0 ] && jq -e '.ok==false' out.json >/dev/null && echo "honest failure (exit=$ec)" || echo "CHECK FAILED"; \
  rm -f out.json
```

## Where elv's contract lives (start reading here for elv audits)

- `src/core/envelope.ts` — `success()` / envelope shape, `emitAndExit`.
- `src/core/errors.ts` — `envelopeForError()`, `validationError()`, error→exit-code mapping.
- `src/core/types.ts` — the `ExitCode` enum (the dictionary).
- `src/cli.ts` — top-level dispatch; every path ends in `emitAndExit(env, exitCode)`.
- `AGENTS.md` — the published contract this skill checks conformance against.

Concrete TypeScript before/after fixes for the common findings: **[RECIPES.md](RECIPES.md)**.
