# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- CLI produced no output when run through its `bin` symlink (`npm link`, `npm install -g`, `npx`); the entrypoint guard now resolves symlinks on both sides so `main()` runs.
- Removed internal build-phase labels that leaked into user-facing output (the registry-cache warning and the not-implemented error).
- Voice-by-name resolution (`voices find`, `tts --voice`, `voice-change --voice`) returned nothing for built-in voices because the large `get_voices` response spilled to disk before the name match ran; resolver lookups now read it inline.
- `tts --timestamps` wrote raw JSON into the audio file (or, for short clips, dumped a base64 blob to stdout); it now decodes the audio to the output file and writes the alignment to a `*.timestamps.json` sidecar, keeping the envelope small.
- Voice cloning and other multipart uploads (`voices clone-instant`/`add_voice`, `add_pvc_voice_samples`, `edit_voice`, `request_pvc_manual_verification`, `video_to_music`) failed validation because array-of-binary file fields were not recognized; the field classifier and request validation now handle them.
- Per-command help (for example `elv tts --help`) returned the global command list instead of that command's own flags and arguments.
- The large-output hint advertised a nonexistent `elv view … --jq` command; it now suggests a real `jq`/`cat` on the spilled file.
- The `cost_header_absent` warning fired on every read; it now appears only for operations that are expected to bill.
- `elv wait` required `--failure` even when only a success condition mattered; `--failure` is now optional.

### Changed

- The published package now ships the agent setup guide (`docs/`) and the bundled `elv` skill (`skills/`).
- Bumped `music-metadata` to v11; clone-and-build instructions now use `npm ci`.
- The default output directory moved from the working-directory-relative `./.elv/out` (which littered any repo you ran `elv` in) to `~/.cache/elv/out`; `--out`, `ELV_OUTPUT_DIR`, and a profile's `output_dir` still override it, and an extensionless `--out` path is now treated as a directory.

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
