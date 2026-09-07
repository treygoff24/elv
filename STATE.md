# STATE: elv (ElevenLabs agent CLI)

**Updated:** 2026-09-07

## Ready for dogfooding
- Installed `elv 0.4.0` matches the reviewed build (`2231dc693636e8b0`); repo, installed-package, and active skill files match.
- Linux/devbox improvements are complete under `elv-t2y`. Node 22/26 gates passed 884 tests and 30 smoke cases each, with 3 live-API skips.
- The installed launcher matches Linux template `6abda82`, now on Forgejo main. Actual PATH smoke and broker/XDG parity passed.
- Finished elv worktrees, workspace run records, audit reports, temp files, and obsolete rollback copies were deleted at Trey's request. Implementation history remains in Git.
- Speech Engine hosting and WebRTC transport remain cut from 0.4.0; `get_livekit_token` is still available through `call`.

## Open decisions and limitations
- **No npm publication or tag.** Dogfood first, then resolve the release decision in `elv-w9t`. GitHub pushes still need explicit authorization.
- The keyless online doctor reports skip on a 3xx; duplex callers must keep draining stderr. These remain deliberate, documented limits.
- Retry fixture `elv-706` failed intermittently during cleanup verification. Unchanged focused and full reruns passed; the assertion was not relaxed.

## Next action
Use the installed CLI for real work and file concrete friction as beads. Do not publish automatically.

## Development
Use `npm run gate` and `npm run smoke:pack`. `npm run verify:install` checks local parity; add `-- --install --sync-skill` for deliberate updates. Keep lasting release notes in `CHANGELOG.md` and commits, not local transcripts.
