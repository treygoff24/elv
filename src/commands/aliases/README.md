# `src/commands/aliases/`

Hand-written shortcuts over the compiled OpenAPI registry: `elv tts`, `elv stt`,
`elv voices`, `elv agents`, and the rest. Each alias builds an `operationId` plus
an input record and hands it to the generic runner — aliases never speak HTTP
themselves.

## Where things live

- **`shared.ts` — the shared helper surface. Start here.** Not `helpers.ts`,
  not `utils.ts`. It exports `runAlias` / `runListAlias` (build → run → emit),
  `aliasRunOpts`, `commandName`, `emit`, `validationOrExit`, `addPaginationFlags`,
  `projectFields`, `waitAfterCreate`, `readJsonBody`, `required`, `requiredPath`,
  `compact`, and `compactInput`.
- **`index.ts`** — the registration list. `registerAliases()` calls one
  `register<Name>Command(program, addCommonFlags)` per file; a new alias file is
  only reachable once it is wired in here.
- **One file per alias surface** (`tts.ts`, `agents.ts`, …), each exporting its
  `register<Name>Command` plus `build<Thing>Input` functions. The `build*`
  functions are pure — flags in, `{ operationId, input }` out — which is what the
  tests in `tests/commands/aliases*.test.ts` exercise directly.

## Conventions

- Validation throws a plain `Error`; `runAlias` / `validationOrExit` converts it
  into a validation-error envelope with exit 2. Never emit envelopes by hand.
- Parent commands (`agents`, `agents tests`, `workspace`, …) carry no action.
  A bare parent is answered with the structured help envelope by `src/cli.ts`.
- Flags that take a JSON body use `--json` / `--json-file` via `readJsonBody`.
