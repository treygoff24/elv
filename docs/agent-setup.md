# Agent setup guide

This guide is for an AI agent installing `elv` on a fresh machine and verifying it works. Follow it top to bottom. Every step is non-interactive and copy-pasteable. When a step has a check, run the check before moving on.

## What you'll end up with

A working `elv` command that authenticates to ElevenLabs, passes `elv config doctor`, and can run a zero-cost dry-run. You will not spend any credits by following this guide.

## Prerequisites

You need Node 22 or newer and git. Confirm both before doing anything else:

```bash
node --version   # must be v22.x or higher
git --version
```

If `node --version` reports anything below v22, stop and install Node 22+ first. `elv` declares `"engines": { "node": ">=22" }` and `config doctor` will fail the Node check on older versions.

## Step 1: Install

Install the published package globally:

```bash
npm install -g eleven-agent-cli
elv --version
```

Confirm the binary responds before continuing. The version command prints a JSON envelope and exits 0.

If you'd rather build from source (contributing, or pinning to an unreleased commit), clone and build instead:

```bash
git clone https://github.com/treygoff24/elv.git
cd elv
npm ci
npm run build
```

`npm run build` runs `tsup` and produces `dist/cli.js`, which is the CLI entry point. If the build fails, run `npm run typecheck` to see the underlying TypeScript errors.

## Step 2: Make `elv` runnable

If you installed via `npm install -g`, `elv` is already on your PATH — skip to Step 3.

Building from source, pick one of two approaches. To get a global `elv` command on your PATH, link the package:

```bash
npm link
elv --version
```

If you cannot or do not want to link globally, invoke the built file directly. Everywhere this guide writes `elv`, substitute `node dist/cli.js` from the repo root:

```bash
node dist/cli.js --version
```

## Step 3: Provide the API key

`elv` reads the key from the environment and sends it as the `xi-api-key` header. Two rules are absolute:

1. Never pass the key as a command-line argument. It is read only from the environment (or a profile that names an environment variable). Passing it as an arg would risk leaking it into shell history and process listings. The key never appears in `elv` output, dry-run previews, debug logs, or written files, and keeping it out of argv keeps it that way.
2. Never commit the key. Do not write it into any tracked file. The repo's `.gitignore` already excludes the `.elv/` directory, and by default `elv` writes its output outside the repo under `~/.cache/elv/out`, so nothing it produces lands in a tracked file.

The simplest setup is a single environment variable:

```bash
export ELEVENLABS_API_KEY=your_key_here
```

If you need more than one configuration (for example, separate accounts or residencies), use a named profile instead. Create `.elv/config.json` in the working directory, or `~/.config/elv/config.json` for a user-wide setup:

```json
{
  "default_profile": "main",
  "profiles": {
    "main": {
      "base_url": "https://api.elevenlabs.io",
      "api_key_env": "ELEVENLABS_API_KEY",
      "output_dir": "./.elv/out",
      "max_credits": 1000
    }
  }
}
```

Note what the config file stores: `api_key_env` is the name of the environment variable that holds the key, not the key itself. The secret value still lives only in the environment. The `output_dir` above is an explicit override; omit it and `elv` writes to the default `~/.cache/elv/out`. Select a profile at runtime with `--profile main` or by setting `ELV_PROFILE=main`.

## Step 4: Verify the environment

Run the doctor. It checks the things that commonly break a setup:

```bash
elv config doctor
```

The envelope contains a `checks` array covering, in order, the API key being present, the base URL being set, the spec registry cache, the output directory being writable, the Node version, base-URL reachability, and the credit balance. The command exits 0 when all required checks pass and nonzero (exit 8) if any check fails. A `warn` on the registry cache is not a failure; Step 6 explains it.

Also confirm config resolution looks right:

```bash
elv config get
```

This prints the resolved base URL, output directory, active profile, cache directory, and whether an API key was found, with no secret values.

## Step 5: Run a zero-cost dry-run

Prove the call path works without spending credits. `--dry-run` validates the request and returns a redacted preview without touching the network, and it runs before the confirmation and budget gates:

```bash
elv tts --voice-id JBFqnCBsd6RMkjVDRZzb --text "Setup verification." \
  --model eleven_flash_v2_5 --dry-run
```

A success here (exit 0, an envelope with `would_require_yes`, `would_exceed_budget`, `credits_estimated`, and the previewed `request`) means the CLI is built correctly, the key is wired up, and the operation validates. Do not dry-run a secret-create operation with a real secret value, because redaction is keyed on field names and may echo a secret passed in the body.

A read that costs nothing is another good smoke test:

```bash
elv usage
```

## Step 6: Discover operations

`elv` exposes all 320 operations in the ElevenLabs OpenAPI spec. Find them by searching the registry, inspect one, then copy a runnable skeleton:

```bash
elv ops search "text to speech"
elv ops get text_to_speech_full
elv ops schema text_to_speech_full --example
```

The `--example` output is a ready-to-run `elv call` skeleton. For common workflows there are twelve aliases (`tts`, `stt`, `music`, `sfx`, `voice-change`, `voice-isolate`, `dubbing`, `voices`, `agents`, `models`, `history`, `usage`) that build the input for you and call the same runner. For everything else, use `elv call <operation_id> --json '{...}'`, or the `http`, `ws`, and `wait` escape hatches.

## Troubleshooting

### Discovery returns nothing, or the registry cache warns

Discovery reads a compiled registry cached under `~/.cache/elv` (override the location with `ELV_CACHE_DIR`). On a fresh machine that cache may not exist yet, which is why `config doctor` can report the registry as a `warn` rather than a failure. The package ships the full spec as a vendored snapshot at `spec/openapi.snapshot.json`, so you can build the cache offline with no network access:

```bash
elv spec update --offline
```

That recompiles the registry from the bundled snapshot. To instead pull the latest spec live from ElevenLabs, run `elv spec update` (no flag), or `elv spec update --from <url-or-file>` for a specific source.

### A command failed: read the exit code first

`elv` is designed so you branch on the exit code before parsing the envelope. Match the failure to its cause:

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | Success | Read `files[]` in the envelope for any output |
| 2 | Input or validation | Fix the parameters; check `elv ops schema <id>` |
| 3 | Auth or permission | Check `ELEVENLABS_API_KEY` and the active profile |
| 4 | Confirmation required | Re-run with `--yes` (the op has a side effect) |
| 5 | Budget ceiling | Raise `--max-credits` or reduce the request size |
| 6 | Out of credits | Top up the ElevenLabs account |
| 7 | Transient, retries exhausted | Wait and retry; check `retry` in the envelope |
| 8 | Provider error | Inspect the normalized `error` in the envelope |
| 9 | Not found | Check the `operation_id` or path; it does not exist |

### Output went somewhere unexpected

Binary and large payloads are not printed to stdout; they are written to disk and referenced as `files[]` in the envelope. By default they land in `~/.cache/elv/out`. Change the destination per command with `--out <file-or-dir>`, or globally with `ELV_OUTPUT_DIR` or a profile's `output_dir`.

### The build or typecheck fails

Confirm Node is 22 or newer, delete `node_modules` and reinstall with `npm ci`, then `npm run build`. Run `npm run typecheck` for the detailed TypeScript output and `npm test` to confirm the suite passes.

## You're done

When `elv config doctor` exits 0 and the dry-run in Step 5 returns a success envelope, the install is verified. For the runtime contract (envelope shape, safety flags, budget caps), read [AGENTS.md](../AGENTS.md). For day-to-day usage, the shipped skill is at [skills/elv/SKILL.md](../skills/elv/SKILL.md).
