# Discovery and generic calls

Read this reference when an alias does not clearly own the request, when the
input schema is uncertain, or when the task needs raw REST, pagination, polling,
profiles, or spec provenance.

## Discover before composing

Use the narrowest lookup that resolves the uncertainty:

```bash
elv capabilities
elv <parent-command>
elv <command> --help
elv ops list --risk generate --limit 20
elv ops search "text to speech"
elv ops get text_to_speech_full
elv ops schema text_to_speech_full --example
elv ops schema text_to_speech_full --raw
elv spec status
```

Bare parent commands are discovery commands: they return a success envelope
containing their subcommands. `ops search` finds candidate operation IDs;
`ops get` confirms method, path, inputs, risk, cost policy, and deprecation;
`ops schema --example` supplies a runnable skeleton. Treat this installed output
as authoritative over remembered counts or documentation snapshots.

Use `spec diff` to inspect drift. Refresh the active cache with `spec update`
only when the task calls for a new contract; the vendored registry remains the
offline fallback.

## Generic call shape

`call` takes one object with `path`, `query`, `body`, and `files` buckets:

```bash
elv call text_to_speech_full \
  --json '{"path":{"voice_id":"VOICE_ID"},"body":{"text":"Hello","model_id":"eleven_flash_v2_5"}}' \
  --out ./out
```

Equivalent input sources are `--json-file <path>` and `--stdin-json`. Repeated
`--path key=value`, `--query key=value`, and `--file field=path` flags are useful
for small requests. Use `--allow-unknown` only when intentionally sending a body
field absent from the installed schema.

For an unfamiliar operation:

1. `ops get` must show it as callable.
2. Build from the `ops schema --example` buckets.
3. Replace every placeholder.
4. Dry-run writes and generation.
5. Execute only after confirmation and budget policy are resolved.

Completion: the final envelope names the expected `operation_id` and HTTP
target, or returns a specific preflight error without a network call.

## Raw REST

```bash
elv http GET /v1/user
elv http POST /v1/example --json-file request.json --dry-run
```

Known paths inherit registry risk and cost metadata. Unknown paths remain
forward-compatible but cannot inherit facts the registry does not know. Treat an
unknown write as unbounded and side-effecting until its preview proves otherwise.

## Pagination and projection

List aliases and supported `call`/`http` operations use:

- `--limit N`: page size and inline cap;
- `--fields a,b`: project alias rows inline;
- `--all`: walk every page and write the result;
- `--save-json <path>` or `--out <path>`: required destination for `--all`.

Examples:

```bash
elv voices list --fields voice_id,name
elv history list --limit 20
elv agents list --all --save-json agents.json
```

When a single page spills, use the returned `next` command rather than manually
reconstructing its cursor.

## Polling

```bash
elv wait \
  --operation get_dubbed_metadata \
  --json '{"path":{"dubbing_id":"DUB_ID"}}' \
  --status-path '$.data.status' \
  --success dubbed \
  --failure failed \
  --interval-ms 2000 \
  --timeout-ms 600000
```

`--failure` is optional for success-only polling. Preserve the same profile,
base URL, output, and auth context as the operation being polled.

## Config and auth

```bash
elv config get
elv config doctor
elv spec status
```

Profiles can supply base URL, output directory, default model, and maximum
credits. Environment and command flags may override them. Diagnose the resolved
state with the CLI rather than guessing cache or config paths.
