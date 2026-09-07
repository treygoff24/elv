#!/bin/sh
# Offline JSON-envelope smoke matrix for the built CLI.
#
# Why this exists: the natural way to smoke a JSON-envelope CLI from the shell is
# `for cmd in "spec status" "ops get x"; do elv $cmd; done`, which word-splits the
# quoted strings and quietly runs the wrong command (or stops after the first
# token). Rows in scripts/smoke-matrix.tsv are argument LISTS, split here on
# purpose with `set --`, so a multi-word command can never be mangled.
#
# Usage:
#   scripts/smoke.sh [matrix.tsv]
#
# Env:
#   ELV_BIN   executable to smoke (default: node dist/cli.js, built if missing).
#             Point it at the installed binary to verify the runtime agents
#             actually get:  ELV_BIN="$(command -v elv)" scripts/smoke.sh
#   ELV_NO_EGRESS_ALLOW
#             comma-separated hosts the no-egress preload should let through.
#             Needed only when ELV_BIN is a launcher that reaches a broker on a
#             non-loopback address; an allowlisted host is outside the offline
#             guarantee, so name the broker and nothing else.
#
# Offline is enforced, not assumed. Unsetting ELEVENLABS_API_KEY proves nothing
# when ELV_BIN is a credential-injecting wrapper that re-adds the key, so this
# run also preloads scripts/no-egress.mjs through NODE_OPTIONS, which every
# descendant Node process inherits: any non-loopback TCP, TLS, DNS or fetch is
# refused before a packet leaves. Read that file for the exact scope. The unset
# stays as a second layer, and a throwaway ELV_CACHE_DIR keeps the run from
# depending on or mutating the real registry cache.
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd)

unset ELEVENLABS_API_KEY || true

created_cache=0
reason_file=
cleanup() {
  rm -f "$reason_file"
  if [ "$created_cache" = 1 ]; then rm -rf "$ELV_CACHE_DIR"; fi
}

if [ -z "${ELV_CACHE_DIR:-}" ]; then
  ELV_CACHE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/elv-smoke-cache.XXXXXX")
  export ELV_CACHE_DIR
  created_cache=1
  trap cleanup EXIT INT TERM
fi
test -d "$ELV_CACHE_DIR" || {
  echo "smoke: ELV_CACHE_DIR is not a directory: $ELV_CACHE_DIR" >&2
  exit 1
}
reason_file=$(mktemp "$ELV_CACHE_DIR/elv-smoke-reason.XXXXXX")
trap cleanup EXIT INT TERM

MATRIX=${1:-scripts/smoke-matrix.tsv}
test -f "$MATRIX" || {
  echo "smoke: missing matrix file: $MATRIX" >&2
  exit 1
}

if [ -z "${ELV_BIN:-}" ] && [ ! -f dist/cli.js ]; then
  echo "smoke: dist/cli.js missing, building"
  npm run build >/dev/null
fi

# Armed after the build: the bundler has no business reaching the network
# either, but a build failure caused by the preload would be a confusing way to
# learn that.
BLOCKER="$ROOT/scripts/no-egress.mjs"
test -f "$BLOCKER" || {
  echo "smoke: missing network blocker: $BLOCKER" >&2
  exit 1
}
BLOCKER_URL=$(node -e 'process.stdout.write(require("node:url").pathToFileURL(process.argv[1]).href)' "$BLOCKER")
NODE_OPTIONS="--import=$BLOCKER_URL${NODE_OPTIONS:+ $NODE_OPTIONS}"
export NODE_OPTIONS

run_elv() {
  if [ -n "${ELV_BIN:-}" ]; then
    "$ELV_BIN" "$@"
  else
    node dist/cli.js "$@"
  fi
}

tab=$(printf '\t')
passed=0
failed=0

while IFS="$tab" read -r want args; do
  case "$want" in
    '' | '#'*) continue ;;
  esac
  test -n "$args" || {
    echo "smoke: row for exit $want has no arguments" >&2
    exit 1
  }

  # Deliberate word split: matrix rows are plain argument tokens.
  # shellcheck disable=SC2086
  set -- $args

  rc=0
  out=$(run_elv "$@" 2>/dev/null </dev/null) || rc=$?

  if [ "$rc" != "$want" ]; then
    printf 'FAIL  elv %s\n      exit %s, expected %s\n' "$args" "$rc" "$want" >&2
    failed=$((failed + 1))
    continue
  fi

  if ! printf '%s' "$out" | node scripts/assert-envelope.mjs "$want" >/dev/null 2>"$reason_file"; then
    printf 'FAIL  elv %s\n      %s\n' "$args" "$(cat "$reason_file")" >&2
    : >"$reason_file"
    failed=$((failed + 1))
    continue
  fi
  : >"$reason_file"

  printf 'ok    elv %s (exit %s)\n' "$args" "$rc"
  passed=$((passed + 1))
done <"$MATRIX"

if [ "$failed" -gt 0 ]; then
  echo "smoke: $failed failed, $passed passed" >&2
  exit 1
fi
echo "smoke: $passed passed"
