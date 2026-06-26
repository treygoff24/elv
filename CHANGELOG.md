# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- CLI produced no output when run through its `bin` symlink (`npm link`, `npm install -g`, `npx`); the entrypoint guard now resolves symlinks on both sides so `main()` runs.
- Removed internal build-phase labels that leaked into user-facing output (the registry-cache warning and the not-implemented error).

### Changed

- The published package now ships the agent setup guide (`docs/`) and the bundled `elv` skill (`skills/`).
- Bumped `music-metadata` to v11; clone-and-build instructions now use `npm ci`.

### Security

- Cleared all dependency advisories: `music-metadata` v11 resolves the transitive `file-type` infinite-loop, and `esbuild` is pinned to a patched 0.28.1. `npm audit` reports zero vulnerabilities.

### Removed

- Internal build specs (`specv1.md`, `specv2.md`) that should not ship in a public repo.

## [0.1.0] - 2026-06-25

### Added

- Initial agent-first ElevenLabs CLI over the ElevenLabs OpenAPI spec.
- Operation runner for the generated OpenAPI operation catalog.
- Twelve workflow aliases for common text to speech, speech to text, music, sound effect, voice, agent, history, usage, and discovery tasks.
- `http`, `ws`, and `wait` escape hatches for raw REST calls, scripted WebSocket sessions, and polling workflows.
- Operation discovery commands for search, details, schemas, and runnable examples.
- One-envelope command contract for success and error output.
- Safety model for `--yes`, `--max-credits`, and `--dry-run`.
