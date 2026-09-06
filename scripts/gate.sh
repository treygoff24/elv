#!/bin/sh
# Canonical repo gate. Fail-fast: any failing check aborts the run.
# Formatting is oxfmt and linting is oxlint — do not substitute prettier or
# eslint, and do not pass eslint-era flags such as --no-cache to oxlint.
set -eu
cd "$(dirname "$0")/.."
node --version
npm --version
./node_modules/.bin/oxfmt --version
./node_modules/.bin/oxlint --version
./node_modules/.bin/tsc --version
./node_modules/.bin/tsup --version
./node_modules/.bin/vitest --version
npm run format:check
npm run lint
npm run typecheck
npm run build
npm run test
# Envelope contract of the built artifact, offline. Catches contract drift that
# unit tests spawning `tsx src/cli.ts` cannot see.
sh "$(dirname "$0")/smoke.sh"
echo "gate: all checks passed"
