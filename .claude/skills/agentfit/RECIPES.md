# agentfit recipes — TypeScript/Node fixes for the common findings

Each recipe is a root-cause fix, not a per-call-site patch. Find the shared module
(elv: `src/core/{envelope,errors,types}.ts`), fix it there, and every command inherits it.
Calibrated to elv's envelope contract; the shapes generalize to any TS CLI.

---

## R1 — Error that doesn't teach (Axiom 4)

An agent that gets `unknown flag --voice` learns nothing. An agent that gets the corrected
command learns the spelling forever.

```ts
// ✗ before
return validationError(cmd, "unknown flag: --voice");

// ✓ after — name what failed, where, and the exact corrected command
return validationError(cmd, {
  message: "unknown flag --voice for `elv tts`",
  hint: "did you mean --voice-id?",
  corrected_command: `elv tts --voice-id <ID> --text "..."`,
});
```

Put `hint` and `corrected_command` in the `ErrorEnvelope` shape once (`src/core/errors.ts`);
every command that builds an error gets the fields for free. The agent reads `corrected_command`
and retries without a human round-trip.

---

## R2 — Exit 1 for "no results" (Axioms 2, 3)

"Ran fine, found nothing" is success, not failure. Exit 1 makes the agent think it broke.

```ts
// ✗ before
if (results.length === 0) { process.exit(1); }

// ✓ after — success envelope, empty array, exit 0
return emitAndExit(success({ cmd, data: { results: [] } }), ExitCode.Success);
```

Reserve non-zero exits for the documented dictionary in `ExitCode`. An empty result set is
data, and the agent branches on `data.results.length`, not on a misused exit code.

---

## R3 — Flag/command typo wedges the agent (Axiom 5)

One typo should produce a correction, not a dead end. A Levenshtein-1 suggestion over the
known token set is table stakes.

```ts
// known commands/flags are already enumerated by commander/your registry
function suggest(input: string, known: string[]): string | undefined {
  return known.find((k) => levenshtein(input, k) <= 1);
}

// in the unknown-command/flag handler:
const did = suggest(badToken, knownTokens);
return validationError(cmd, {
  message: `unknown ${kind}: ${badToken}`,
  ...(did && { hint: `did you mean ${did}?`, corrected_command: rebuild(argv, badToken, did) }),
});
```

Keep `knownTokens` derived from the live command/flag registry so it can't drift out of sync
with what the CLI actually accepts.

---

## R4 — A path that skips the envelope (Axiom 6)

Every exit — help, error, empty, success — must go through one emitter. A `console.log` or a
bare `throw` that escapes `emitAndExit` is a contract hole an agent's parser falls into.

```ts
// ✗ before — raw write bypasses the envelope
console.log(JSON.stringify(data));

// ✓ after — single emitter, single shape
emitAndExit(success({ cmd, data }), ExitCode.Success);
```

Audit move: grep for `console.log`, `process.stdout.write`, and `throw` outside the central
error handler. Each hit is a candidate Axiom-6 finding. The fix routes it through
`emitAndExit` / `envelopeForError`.

---

## R5 — ANSI / color leaks into non-TTY output (Axiom 10)

Styling belongs to humans at a terminal, never to a pipe.

```ts
// ✓ central gate, computed once at startup
export const useColor =
  process.stdout.isTTY === true &&
  !process.env.NO_COLOR &&
  process.env.TERM !== "dumb" &&
  process.env.CI !== "true";

const paint = (s: string, code: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
```

For an agent-first CLI like elv where stdout is always JSON, the stronger rule is: **never**
write ANSI to stdout at all — color is a stderr-only affordance, and even there it's gated by
`useColor`.

---

## R6 — Wall-clock / nondeterminism in stdout (Axiom 9)

Same input must yield the same bytes, so snapshot tests and agent diffs are stable.

```ts
// ✗ before — timestamp baked into output text
data.generated_at = new Date().toISOString();

// ✓ after — honor SOURCE_DATE_EPOCH; keep it a structured field, not prose
const epoch = process.env.SOURCE_DATE_EPOCH;
data.generated_at = epoch ? new Date(Number(epoch) * 1000).toISOString() : new Date().toISOString();
```

Also: sort object keys / array results before emitting, and prefer content-derived IDs over
auto-increment so output is stable across machines. Pin it with a snapshot test that runs the
command twice under `SOURCE_DATE_EPOCH=0` and diffs the bytes.

---

## R7 — Dangerous op without a named safe alternative (Axiom 8)

The gate (`--yes`) is necessary but not sufficient — the *refusal* must teach the safe path.

```ts
// ✓ the exit-4 (confirmation-required) envelope names the alternative
return emitAndExit(
  errorEnvelope(cmd, {
    message: "delete_voice is destructive and requires confirmation",
    hint: "re-run with --yes to confirm, or --dry-run to preview without deleting",
    corrected_command: `elv call delete_voice --path voice_id=${id} --yes`,
  }),
  ExitCode.ConfirmationRequired,
);
```

The agent gets the exit code (branch), the reason (parse), and both the confirm path and the
no-network preview path — it can choose safety without guessing.

---

## Test discipline (ponytail)

A fix lands one runnable check, not a suite. For elv that's a `vitest` case asserting the
post-fix behavior and failing against the pre-fix code:

```ts
test("empty result set is success, not exit 1", async () => {
  const { exitCode, stdout } = await runElv(["voices", "--query", "no-such-voice"]);
  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({ ok: true, data: { results: [] } });
});
```

One assertion that breaks if the finding regresses. No fixtures, no per-function suites unless
the change genuinely needs them.
