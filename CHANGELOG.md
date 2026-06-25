# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-06-25

### Added

- Initial agent-first ElevenLabs CLI over the ElevenLabs OpenAPI spec.
- Operation runner for the generated OpenAPI operation catalog.
- Twelve workflow aliases for common text to speech, speech to text, music, sound effect, voice, agent, history, usage, and discovery tasks.
- `http`, `ws`, and `wait` escape hatches for raw REST calls, scripted WebSocket sessions, and polling workflows.
- Operation discovery commands for search, details, schemas, and runnable examples.
- One-envelope command contract for success and error output.
- Safety model for `--yes`, `--max-credits`, and `--dry-run`.
