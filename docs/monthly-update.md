# Monthly update facts

Cycle skill: `cli-monthly-update` (skill pool; `claude-skill add
cli-monthly-update` activates it for this repo). This file holds only what
that skill leaves abstract. Every command below is offline unless it says
live; nothing here makes a paid ElevenLabs call.

## Upstream

- Spec source: `https://api.elevenlabs.io/openapi.json`, vendored as the raw
  retrieved bytes at `spec/openapi.snapshot.json` (one ~2 MB line: `.ignore`
  hides it from ripgrep and `.gitattributes` marks it binary; query it with
  `jq` or `elv ops search|get|schema`, never `cat`/`rg` it). Provenance is
  `spec/openapi.snapshot.meta.json` (`source`, `retrieved_at`, `sha256`,
  paths / total / callable / skipped operations, schemas); `elv spec status`
  reports `vendored_metadata_verified` against the file.
- Check mode (live, unauthenticated, free): `elv spec diff` fetches the
  current document, compares it with the vendored snapshot, and prints the
  fresh provenance (sha256 and counts) plus added, changed, and removed
  operations and schemas. It writes nothing. `elv spec update --from
  spec/openapi.snapshot.json --dry-run` recompiles a local file offline.
  Plain `elv spec update` writes the user cache
  (`~/.cache/elv/<version>/openapi.compact.json`), not the repo; lanes never
  run it without `--dry-run`.
- Write mode has no script. Replace both files together: `curl -sS
  https://api.elevenlabs.io/openapi.json -o spec/openapi.snapshot.json`,
  then rewrite the meta file with the fetch time (UTC), `sha256sum` of the
  file, and the counts `elv spec diff` printed. Rebuild and confirm
  `node dist/cli.js spec status` says `vendored_metadata_verified: true`.
  Commit `e1066a2` (2026-09-21) is the worked example.
- Pinned counts live in tests (`tests/commands/capabilities-contract.test.ts`,
  `tests/openapi/openapi-compile.test.ts`, `openapi-registry.test.ts`,
  `openapi-update-spec.test.ts`) and in five documents that
  `tests/openapi/docs-coverage-counts.test.ts` binds to the meta file with
  exact sentences: `README.md`, `AGENTS.md`, `skills/elv/SKILL.md`,
  `docs/agent-setup.md`, `docs/api-coverage.md` (the last also carries the
  sha256, retrieval time, and the deprecation table).
- Withdrawn or deprecated surface rarely appears as a removed path. Read
  https://elevenlabs.io/docs/changelog (every entry since `retrieved_at`),
  https://elevenlabs.io/docs/api-reference, https://elevenlabs.io/docs/llms.txt,
  https://elevenlabs.io/blog, and the official SDKs (`elevenlabs/elevenlabs-python`,
  `elevenlabs/elevenlabs-js` on GitHub). Deprecations also hide inside schema
  descriptions (`music_v1` was marked deprecated only in `MusicModelID`;
  `jq '.components.schemas.MusicModelID' spec/openapi.snapshot.json`).
- Papercut search: `papercuts list --all --status open --format md
  --limit 300`, then filter text for `elv`, `eleven-agent-cli`, `elevenlabs`,
  `ELEVENLABS_API_KEY`. Tags in use: `elv`, `hints`, `exit-codes`, `spec`,
  `examples`, `discovery`, `beads`. This repo's ledger `.papercuts.jsonl` is
  gitignored, so resolve from this directory and cite the fixing commit in
  the note. Last cycle's cut sweep was also a dogfood lane against the
  installed binary (`NO_COLOR=1 CI=1`, no paid calls) that filed its findings
  into this ledger as `fable-elv-monthly`.

## Build and gate

- Full gate: `TMPDIR=/var/tmp ELV_TEST_MAX_WORKERS=4 npm run gate`
  (`scripts/gate.sh`: oxfmt check, oxlint, tsc, tsup build to `dist/cli.js`,
  vitest, then the offline smoke matrix; 947 tests, 3 live-API skips, 33
  smoke rows as of 0.5.0). Run it on both supported Node lines:
  `mise x node@22 -- npm run gate` and the default Node 26.9. Only
  `npm run gate` is authoritative; `npx vitest run` alone does not rebuild
  `dist/`.
- Constraints: a long default `TMPDIR` breaks tsx's Unix socket and fails the
  black-box CLI tests (hence `/var/tmp`; `/tmp` is RAM-backed on the cell).
  oxfmt and oxlint, never prettier or eslint. Delegate worktrees start
  without `node_modules`: `npm ci` first.
- Offline: `scripts/no-egress.mjs` is preloaded into the smoke run and
  refuses non-loopback TCP, TLS, DNS, and `fetch`; the three live-API tests
  skip without a key; `--dry-run` on any command is offline. Lanes run with
  no key and never make paid calls.
- Generated artifacts: none are script-generated. The test-bound documents
  above must be edited by hand when the snapshot moves; new aliases need a
  `scripts/smoke-matrix.tsv` row, a `README.md` alias entry, and a
  `skills/elv/` route-map line. `npm run verify:install` (read-only) reports
  drift between the built `dist/cli.js`, the installed package, the repo
  skill, and the pool skill, and checks every route-map command exists.
- Emitted-command parse invariant: `tests/integration/recovery-hints.test.ts`
  runs every `hints[].cmd` from failure envelopes through the real CLI and
  expects exit 0 with `ok: true`; extend its table when a new failure class
  gains hints. `tests/commands/cli-json.test.ts` checks hint shapes.
- Lane reports and briefs: `docs/internal/<date>-monthly/` (gitignored);
  use it wherever the skill's briefs say `reports/`.
- Pack smoke: `npm run smoke:pack` proves the tarball is reproducible and
  installs offline; on `ENOTCACHED`, `npm cache add <pkg>@<version>` the
  locked production packages and re-run.

## Ship

- Version in `package.json` (`npm version --no-git-tag-version X.Y.Z`).
  `CHANGELOG.md` is Keep a Changelog: `## [Unreleased]` stays on top,
  `## [X.Y.Z] - YYYY-MM-DD` per release with Security / Added / Changed /
  Fixed / Deprecated subsections. Bump `STATE.md` at the repo root (this
  repo has no `work/` directory; local cycle scratch and lane briefs live
  under gitignored `docs/internal/<date>-monthly/`).
- CI: `.github/workflows/ci.yml`, one `test` job on ubuntu Node 22, ubuntu
  Node 26, and macOS Node 22, running `npm run gate` then `npm run
  smoke:pack`. No release workflow, no tags, no build assets.
- Release is `npm publish` of `eleven-agent-cli` (public; `files` allowlist in
  `package.json`; `prepack` builds). Publishing needs an interactive login
  and a 2FA tap: `npm login --auth-type=web` prints a link that dies after a
  few minutes of polling, so hand it over immediately (or loop the login and
  republish the link); then run `npm publish` under a pty (`script -qfec
  "npm publish" <log>`) so npm prints its `auth/cli` URL and polls it. The
  registry read replica lags the website by minutes; a `409 Cannot publish
  over previously staged version` on a retry means the first publish landed.
  Verify with `npm view eleven-agent-cli dist-tags.latest`. The GitHub push
  (`git push github main`) and the publish each wait for Trey's word; there
  are no git tags so far.
- Local install: `npm run verify:install -- --install --sync-skill` packs
  and installs into the `~/.local` prefix (`~/.local/bin/elv` ->
  `~/.local/lib/node_modules/eleven-agent-cli/dist/cli.js`; the estate shim
  `~/.local/bin/estate-shims/elv` wraps it and supplies the realm key) and
  copies `skills/elv/` into the pool. Then commit the pool skill by pathspec,
  `skill-library-sync`, `skill-render`, and re-run `npm run verify:install`
  until it prints `no drift found`.
- Pool skill to refresh when the playbook changes: `elv`
  (`~/.agents/skill-library/elv`, mirrored from `skills/elv/`; the route map
  is verified against the installed CLI).

## Last cycle

- 2026-09-21: released 0.5.0 (`cf6f02b`; published to npm the same day,
  the first registry release since 0.3.0 because 0.4.0 was never
  published). Carried forward: bead `elv-vht` (parked review minors:
  `hintsForError` empty-rule fallback, `body.file` near-miss when a real
  `--file` is present, `isNonEmpty` counting `{}`), bead `elv-706`
  (intermittent retry fixture), the STATE.md known limits (permission-bit
  output preflight; source-less multipart examples for `create_dubbing`,
  `add_documentation_to_knowledge_base`, `edit_project_content`,
  `dubbing_project_create`, `audio_native_project_update_content_endpoint`),
  and papercut `pc2_7806cf47b1b3ea46` (bd 1.3.0 migration and lock-file
  behaviour; beads tooling, not this CLI).
