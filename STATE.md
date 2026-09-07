# STATE: elv (ElevenLabs agent CLI)

**Updated:** 2026-09-07

## Where things stand
- Linux/devbox improvements are complete under `elv-t2y`. Linux Node 22/26 gates each passed 884 tests and 30 smoke cases, with 3 live-API skips.
- **Not published to npm.** Trey wants to dogfood first; release decision is `elv-w9t`. No release, tag, or GitHub push was performed.
- Installed `elv` matches the reviewed build (`2231dc693636e8b0`). Four skill files match repo/package/active pool. Prior runtime backup: `/var/tmp/elv-linux-opt-20260907/installed-before.tar.gz`.
- Elv's installed launcher matches Linux template `6abda82`. Actual PATH smoke and installed broker/XDG parity passed.
- Speech Engine hosting and the WebRTC transport were built this cycle and cut before release (CHANGELOG 0.4.0 "Removed"); `get_livekit_token` stays reachable via `call`.
- Current assessment/review: `docs/reviews/2026-09-06-linux-devbox-assessment.md` and `docs/reviews/2026-09-07-linux-optimization-review.md`. Earlier parity decisions remain in `docs/reviews/2026-09-06-parity-review.md`; model history is in `model-performance-journal.md` (gitignored, local).

## Open loops
- Shared launcher `6abda82` is included in Forgejo main (`1ce4ffc`). The original Linux checkout remains behind with unrelated dirty files; it was not pulled or reset.
- Original `.claude/worktrees/agent-*` and Delegate lane worktrees remain. Deletion is not part of this task.
- Known, deliberately left: keyless `config doctor --online` reachability probe reports `skip` on a 3xx; `--duplex` needs the caller to keep draining stderr (documented, not bounded).

## Next action
- Dogfood the installed CLI, then resolve `elv-w9t`. Review and benchmark receipts are in the linked optimization review; do not publish automatically.

## How to work here
- Gate: `npm run gate` then `npm run smoke:pack`. `npm run verify:install` reports installed runtime/skill drift; add `-- --install --sync-skill` for deliberate local installation and skill propagation.
- Commits ungated; `origin` (Forgejo) pushes ungated; `github` pushes, tags, and `npm publish` each need Trey's explicit word.
