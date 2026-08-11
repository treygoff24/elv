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
#
# Every row is local-only. ELEVENLABS_API_KEY is unset below so a careless row
# can never reach the provider or spend credits, and the run uses a throwaway
# ELV_CACHE_DIR so it neither depends on nor mutates your real registry cache.
set -eu
cd "$(dirname "$0")/.."

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
