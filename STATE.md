# STATE — elv (ElevenLabs agent CLI)

**Updated:** 2026-09-07

## Where things stand
- CLI changes are verified and installed; the estate merge is pending under `elv-t2y`. Linux Node 22/26 gates each passed 884 tests and 30 smoke cases, with 3 live-API skips.
- **Not published to npm** — Trey wants to dogfood first. Release decision: bead `elv-w9t`. No release/tag/GitHub push is authorized by the optimization task.
- Installed `elv` matches the reviewed build (`2231dc693636e8b0`). Four skill files match repo/package/active pool. Prior runtime backup: `/var/tmp/elv-linux-opt-20260907/installed-before.tar.gz`.
- Speech Engine hosting and the WebRTC transport were built this cycle and cut before release (CHANGELOG 0.4.0 "Removed"); `get_livekit_token` stays reachable via `call`.
- Current assessment/review: `docs/reviews/2026-09-06-linux-devbox-assessment.md` and `docs/reviews/2026-09-07-linux-optimization-review.md`. Earlier parity decisions remain in `docs/reviews/2026-09-06-parity-review.md`; model history is in `model-performance-journal.md` (gitignored, local).

## Open loops
- Await Exa's stable handoff before the live launcher merge. The combined candidate passes elv, Exa, and real-broker fixture tests; no shared files have changed.
- Merged lane branches `fix/core`, `fix/openapi`, `fix/ws` and their `.claude/worktrees/agent-*` checkouts still exist; deletion is Trey's call.
- Known, deliberately left: keyless `config doctor --online` reachability probe reports `skip` on a 3xx; `--duplex` needs the caller to keep draining stderr (documented, not bounded).

## Next action
- Merge and install the combined launcher, measure the resulting runtime, and close `elv-t2y` before returning to dogfood/release decisions.

## How to work here
- Gate: `npm run gate` then `npm run smoke:pack`. `npm run verify:install` reports installed runtime/skill drift; add `-- --install --sync-skill` for deliberate local installation and skill propagation.
- Commits ungated; `origin` (Forgejo) pushes ungated; `github` pushes, tags, and `npm publish` each need Trey's explicit word.
