# Contributing

Thanks for helping improve `elv`.

## Development setup

Use Node.js 22 or newer.

```bash
npm install
```

Before opening a pull request, run the full local gate:

```bash
npm run build && npm run typecheck && npm test && npm run lint
```

Integration tests that need the ElevenLabs API run only when `ELEVENLABS_API_KEY` is set. They skip when the variable is absent, so CI must stay green without an API key.

## Project conventions

This project uses TypeScript ESM with `moduleResolution: "Bundler"`. Import paths do not include `.js` suffixes.

TypeScript is strict and uses `noUncheckedIndexedAccess`. Formatting is handled by `oxfmt`; linting is handled by `oxlint`.

## Pull requests

Keep PRs small and focused. Describe behavior changes clearly. Add tests for non-trivial logic, especially safety checks, envelope behavior, auth handling, request shaping, and retry behavior.
