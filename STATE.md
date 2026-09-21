# STATE: elv (ElevenLabs agent CLI)

**Updated:** 2026-09-21

## 0.5.0 built and installed, publication pending
- Repo is at 0.5.0 (CHANGELOG section `[0.5.0] - 2026-09-21`). The installed `elv 0.5.0` matches the repo build; repo, installed-package, and active skill files match (`npm run verify:install`).
- The vendored OpenAPI snapshot is the September 21, 2026 public spec: 302 paths, 391 documented operations, 390 callable, 1,524 schemas. New surface: `agents hold-audio upload|delete`, `list_phone_numbers_page_route` via `call`, `ws convai` queue events and peer-only close attribution, `ops search` intents, `capabilities` 90-day stale warning, output preflight and recovery hints, and the STT exactly-one-media-source invariant.
- Node 22 and Node 26.9 gates passed 947 tests (3 live-API skips) and 33 smoke rows each; `smoke:pack` installs the 0.5.0 tarball offline (populate the npm cache with the locked production packages first if it reports `ENOTCACHED`).
- Dev dependencies moved within range (`@types/node`, `oxlint` 1.85, `tsx`, `vitest` 3.2.7). Majors are held: TypeScript 7, vitest 5, commander 15, json-schema-ref-parser 16, mime-types 3.
- Speech Engine hosting and WebRTC transport remain cut; `get_livekit_token` is still available through `call`.

## Open decisions and limitations
- **No npm publication, GitHub push, or tag yet.** Bead `elv-3ny.10` holds that decision for Trey; it supersedes `elv-w9t`.
- Output preflight checks directory permission bits, not a probe write, so a root user on a read-only-by-mode directory fails at write time rather than preflight. `elv ws --dry-run` preflights the output target like `elv call` does.
- Multipart example commands still print `{}` bodies for source-less operations whose schema states no exactly-one rule (`create_dubbing`, `add_documentation_to_knowledge_base`, `edit_project_content`, `dubbing_project_create`, `audio_native_project_update_content_endpoint`).
- The keyless online doctor reports skip on a 3xx; duplex callers must keep draining stderr. These remain deliberate, documented limits.
- Retry fixture `elv-706` failed intermittently during 0.4.0 cleanup verification; the assertion was not relaxed and the bead stays open.

## Next action
Trey decides `elv-3ny.10` (GitHub push and `npm publish` of 0.5.0). Until then, dogfood the installed CLI and file friction as beads.

## Development
Run the gate as `TMPDIR=/var/tmp ELV_TEST_MAX_WORKERS=4 npm run gate` (a long default `TMPDIR` breaks tsx's Unix socket and fails the black-box CLI tests). `npx vitest run` alone does not rebuild `dist/`; only `npm run gate` is authoritative. Use `npm run smoke:pack` before a release and `npm run verify:install -- --install --sync-skill` for deliberate local updates. Keep lasting release notes in `CHANGELOG.md` and commits, not local transcripts.
