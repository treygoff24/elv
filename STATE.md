# STATE — elv (ElevenLabs agent CLI)

**Updated:** 2026-09-06

## Where things stand
- 0.4.0 is code-complete on `main` (8f70273), pushed to Forgejo `origin` and `github`. **Not published to npm** — Trey wants to dogfood first. Release decision: bead `elv-w9t`.
- The devbox global `elv` (`~/.local/lib/node_modules/eleven-agent-cli`, reached through `~/.local/bin/estate-shims/elv`) is the 8f70273 build.
- Speech Engine hosting and the WebRTC transport were built this cycle and cut before release (CHANGELOG 0.4.0 "Removed"); `get_livekit_token` stays reachable via `call`.
- Review record: `docs/reviews/2026-09-06-parity-review.md`; narrative: `model-performance-journal.md` (gitignored, local) 2026-09-06 entry; work graph: `bd ready`.

## Open loops
- Dogfood 0.4.0 from the devbox; anything found goes in beads before the publish decision.
- Merged lane branches `fix/core`, `fix/openapi`, `fix/ws` and their `.claude/worktrees/agent-*` checkouts still exist; deletion is Trey's call.
- Known, deliberately left: keyless `config doctor --online` reachability probe reports `skip` on a 3xx; `--duplex` needs the caller to keep draining stderr (documented, not bounded).

## Next action
- Use `elv` for real work; file friction as beads. Then decide `elv-w9t` (publish as-is vs. roll dogfood fixes in).

## How to work here
- Gate: `sh scripts/gate.sh` then `npm run smoke:pack`. Reinstall the devbox binary: `npm pack --pack-destination /var/tmp/elv-pack && npm install -g --prefix "$HOME/.local" /var/tmp/elv-pack/eleven-agent-cli-<ver>.tgz`.
- Commits ungated; `origin` (Forgejo) pushes ungated; `github` pushes, tags, and `npm publish` each need Trey's explicit word.
