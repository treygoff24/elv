---
name: elv
description: >-
  ElevenLabs via `elv`: speech, transcription, music, sound effects, image/video
  generation, voices, dubbing, agents, workspace administration, REST and realtime.
  Use for API discovery and execution. One JSON envelope per command; media and
  large results go to files.
---

# elv

Use the installed `elv` binary for ElevenLabs work. In this repository,
`node dist/cli.js` is the development equivalent. The installed runtime and its
vendored operation registry are the source of truth; discover instead of
guessing flags, operation IDs, models, or API coverage.

The shipped September 6, 2026 registry documents 388 operations: 387 callable
and one skipped deprecated route. Confirm the active contract with
`elv capabilities` and `elv spec status` when freshness matters.

## Run loop

1. **Orient.** When the runtime or auth state is uncertain, run `elv --version`
   and `elv config get`. On an auth failure, run `elv config doctor`.
   Completion: the intended binary is active and the envelope reports whether
   an API key is present without exposing it.
2. **Route.** Prefer a named alias when it matches the job; otherwise use
   `ops` discovery and `call`. Reach for `http`, `ws`, or `wait` only when their
   distinct capability is required. Completion: one command family clearly
   owns the request.
3. **Shape.** Read `elv <command> --help`. For a generic operation, run
   `elv ops get <operation_id>` and then
   `elv ops schema <operation_id> --example`. Completion: every required input
   has a value and no flag or field is invented.
4. **Preflight.** Use `--dry-run` for generation, mutation, outbound activity,
   WebSocket sends, or an unfamiliar raw write. Set `--max-credits` when spend
   must be bounded. Completion: the preview identifies the target, redacted
   request, confirmation requirement, and budget result before network activity.
5. **Execute.** Add `--yes` only after the intended side effect and target are
   confirmed. Branch on the process exit code before parsing the envelope.
   Completion: exactly one envelope is returned and its exit code agrees with
   `ok`.
6. **Close.** Inspect `data` or each path in `files[]`; use `elv view` rather
   than loading a large spill into context. Completion: the requested result is
   verified, or the error envelope supplies the next safe action.

## Route map

| Need | Route |
| --- | --- |
| Common media or account workflow | Alias: `tts`, `stt`, `music`, `sfx`, `flows`, `assets`, `voice-change`, `voice-isolate`, `dubbing`, `dubbing-project`, `voices`, `models`, `agents`, `history`, `usage`, `workspace` |
| Unknown capability or input shape | `capabilities`, then `ops search|get|schema` |
| Published operation without a useful alias | `elv call <operation_id>` |
| Forward-compatible REST path | `elv http <METHOD> <path>` |
| Streaming or realtime protocol | `elv ws <catalog-name|url>` |
| Long-running operation | `elv wait` |

Bare parent commands are discovery: they return a success envelope containing
their subcommands. Choose a listed leaf command before supplying action inputs.

Load the reference for the branch you are taking:

- For operation discovery, generic calls, raw REST, pagination, polling, or
  config/spec questions, read
  [`references/discovery-and-calls.md`](references/discovery-and-calls.md).
- For TTS, STT, music, sound effects, image/video generation, assets, voices, or dubbing recipes, read
  [`references/media-workflows.md`](references/media-workflows.md).
- For conversational agents, workspace administration, Dubbing Project edits,
  or WebSockets, read
  [`references/agents-workspace-ws.md`](references/agents-workspace-ws.md).

## Envelope contract

Stdout is exactly one `v:1` success or error envelope. There is no interactive
prompt, spinner, or prose stream. Binary and large results go to disk and appear
in `files[]`.

Branch on the exit code first:

| Code | Meaning | Default response |
| --- | --- | --- |
| 0 | Success | Inspect `data` or `files[]` |
| 2 | Input or local validation | Correct the request; do not retry unchanged |
| 3 | Auth or permission | Run `elv config doctor`; fix credentials or access |
| 4 | Confirmation required | Confirm intent, then add `--yes` |
| 5 | Budget ceiling | Lower scope or raise `--max-credits` deliberately |
| 6 | Provider credits exhausted | Stop or replenish credits |
| 7 | Retryable failure exhausted | Retry only when duplicate effects are safe |
| 8 | Other provider error | Inspect `error` and `hints[]`; do not assume retryability |
| 9 | Not found | Re-discover the resource or operation ID |

A success usually carries `operation_id`, `http`, `cost`, and either `data` or
`files[]`. An error carries `error.type`, `error.code`, `error.message`,
`retry`, and often `hints[]`.

## Safety invariants

- Put the API key in `ELEVENLABS_API_KEY`; credentials never belong in CLI
  arguments, JSON files committed to a repo, logs, or prompts.
- Treat `--dry-run` as request preview, not as a secret sanitizer. Secret-create
  bodies can contain values whose field names are not recognized; preview them
  with placeholders.
- Destructive, outbound, credential, member, and other curated side effects
  require `--yes`. A missing confirmation exits 4 without performing the call.
- `--max-credits` blocks a bounded operation before network activity when the
  estimate exceeds the ceiling. Generation and supported realtime sessions fail
  closed when a configured ceiling cannot bound them; an unknown raw operation
  can only report `unknown_unbounded`.
- A repeated paid generation may charge twice. After interruption, inspect the
  envelope and provider state before repeating it.
- Credential-bearing responses are file-only with mode `0600` and
  `sensitive:true`; `elv view` refuses to render them.

## Result discipline

Use `--out <file-or-directory>` when the destination matters. Otherwise files
land under the configured output directory. The envelope records path, MIME
type, byte size, and SHA-256.

For spilled JSON or NDJSON:

```bash
elv view <path>
elv view <path> --path data.voices.0.name
elv view <path> --path 'voices[].name' --limit 20
```

For list work, request only what is needed: `--fields <csv>` projects rows,
`--limit N` bounds a page and inline result, and `--all` writes every page to
`--save-json` or `--out`. Prefer these controls over reading a large response
and trimming it afterward.
