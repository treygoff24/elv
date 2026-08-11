#!/bin/sh
# Packed-artifact smoke: build the npm tarball, unpack it, and run the offline
# smoke matrix against the CLI exactly as a consumer would receive it.
#
# Why this exists: unpacking `npm pack` output by hand and running
# `node package/dist/cli.js` fails before the CLI even starts, because the
# tarball ships no node_modules and the runtime deps (commander, ajv, ws, ...)
# are unresolvable. This stages the repo's already-installed node_modules into
# the unpacked tree, so verifying a packed artifact needs no network install.
#
# Usage:
#   scripts/pack-smoke.sh
#
# No network, no credits: scripts/smoke.sh unsets ELEVENLABS_API_KEY and points
# ELV_CACHE_DIR at a throwaway directory.
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd)

test -d node_modules || {
  echo "pack-smoke: node_modules missing; run 'npm ci' first" >&2
  exit 1
}

WORK=$(mktemp -d "${TMPDIR:-/tmp}/elv-pack-smoke.XXXXXX")
trap 'rm -rf "$WORK"' EXIT INT TERM

npm pack --pack-destination "$WORK" >/dev/null 2>&1 || {
  echo "pack-smoke: npm pack failed" >&2
  exit 1
}

tarball=$(find "$WORK" -maxdepth 1 -name '*.tgz' -type f | head -n 1)
test -n "$tarball" || {
  echo "pack-smoke: npm pack produced no tarball in $WORK" >&2
  exit 1
}

tar -xzf "$tarball" -C "$WORK"

# Locate the entrypoint by its unique path suffix rather than assuming the
# tarball's directory depth.
cli=$(find "$WORK" -type f -path '*/dist/cli.js' | head -n 1)
test -n "$cli" || {
  echo "pack-smoke: no dist/cli.js inside $(basename "$tarball")" >&2
  echo "pack-smoke: check the 'files' array in package.json" >&2
  exit 1
}
pkgdir=$(dirname "$(dirname "$cli")")

# The tarball ships no dependencies; borrow the ones already on disk.
ln -s "$ROOT/node_modules" "$pkgdir/node_modules"
chmod +x "$cli"

echo "pack-smoke: smoking $(basename "$tarball") at $pkgdir"
ELV_BIN="$cli" sh "$ROOT/scripts/smoke.sh"
