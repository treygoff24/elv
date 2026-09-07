#!/bin/sh
# Packed-artifact smoke: build the npm tarball, install it the way a user would,
# and run the offline envelope matrix against the resulting global binary.
#
# What this proves that `npm run smoke` cannot:
#   1. `files` in package.json ships the entrypoint, and the archive records it
#      executable — checked by reading the archive, never by chmod'ing it.
#   2. `dependencies` is complete. The install resolves production deps only, so
#      a runtime import that lives in devDependencies fails here.
#   3. The npm-created bin symlink works. `prefix/bin/elv` is a symlink into
#      lib/node_modules, which is the argv[1]-is-a-symlink shape that
#      tests/integration/bin-symlink.test.ts covers at source level.
#   4. `npm pack` is reproducible: two packs of the same tree are byte-identical.
#
# Usage:
#   scripts/pack-smoke.sh
#
# Network: none. The install runs `npm --offline`, so every production dependency
# must already be in the local npm cache; a cache miss is a hard failure with
# remediation rather than a quiet online install. The smoke itself preloads
# scripts/no-egress.mjs (see scripts/smoke.sh).
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd)

WORK=$(mktemp -d "${TMPDIR:-/tmp}/elv-pack-smoke.XXXXXX")
trap 'rm -rf "$WORK"' EXIT INT TERM

# The tarball name is a pure function of name+version; deriving it beats
# globbing a directory and taking whatever came first.
tarball_name=$(node -p 'const p=require("./package.json"); p.name.replace(/^@/, "").replace(/\//, "-") + "-" + p.version + ".tgz"')
tarball="$WORK/$tarball_name"

pack_once() {
  # npm pack runs prepack (the build), which writes to stdout, so --json is not
  # usable here. Keep stderr: a pack failure explains itself there.
  if ! npm pack --pack-destination "$1" >"$1/pack.out" 2>"$1/pack.err"; then
    echo "pack-smoke: npm pack failed" >&2
    cat "$1/pack.err" >&2
    exit 1
  fi
}

mkdir -p "$WORK/first" "$WORK/second"
pack_once "$WORK/first"
pack_once "$WORK/second"
test -f "$WORK/first/$tarball_name" || {
  echo "pack-smoke: npm pack produced no $tarball_name" >&2
  ls -1 "$WORK/first" >&2
  exit 1
}

# 4. Reproducibility. npm normalises file mtimes precisely so this holds; a
# regression means something in the build is leaking a timestamp or ordering.
if ! cmp -s "$WORK/first/$tarball_name" "$WORK/second/$tarball_name"; then
  echo "pack-smoke: two packs of the same tree differ; the build is not reproducible" >&2
  exit 1
fi
cp "$WORK/first/$tarball_name" "$tarball"
echo "pack-smoke: $tarball_name is reproducible ($(wc -c <"$tarball") bytes)"

# 1. Archive inspection. Unique entries only, the entrypoint present exactly
# once, and its recorded mode executable.
tar -tzf "$tarball" | sort >"$WORK/entries.txt"
sort "$WORK/entries.txt" | uniq -d >"$WORK/duplicates.txt"
if [ -s "$WORK/duplicates.txt" ]; then
  echo "pack-smoke: archive contains duplicate entries:" >&2
  cat "$WORK/duplicates.txt" >&2
  exit 1
fi
entry_count=$(command grep -Fxc 'package/dist/cli.js' "$WORK/entries.txt" || true)
test "$entry_count" = "1" || {
  echo "pack-smoke: expected exactly one package/dist/cli.js entry, found $entry_count" >&2
  echo "pack-smoke: check the 'files' array in package.json" >&2
  exit 1
}
archive_mode=$(tar -tvzf "$tarball" | awk '$NF == "package/dist/cli.js" { print $1 }')
case "$archive_mode" in
  *x*x*x*) echo "pack-smoke: archive records dist/cli.js as $archive_mode" ;;
  *)
    echo "pack-smoke: archive records dist/cli.js as '$archive_mode', expected an executable mode" >&2
    exit 1
    ;;
esac

# 2 and 3. Install exactly what a consumer gets, production deps only, from the
# local npm cache. --ignore-scripts because a lifecycle script has no business
# running during a verification install.
PREFIX="$WORK/prefix"
if ! npm install --global --prefix "$PREFIX" --offline --ignore-scripts \
  --no-audit --no-fund "$tarball" >"$WORK/install.log" 2>&1; then
  echo "pack-smoke: offline install of $tarball_name failed" >&2
  cat "$WORK/install.log" >&2
  echo "pack-smoke: this check never installs from the network. If the log shows" >&2
  echo "pack-smoke: a cache miss, populate the cache online first (npm ci in this" >&2
  echo "pack-smoke: repo, or npm cache add <pkg>@<version>) and re-run." >&2
  exit 1
fi

pkgdir="$PREFIX/lib/node_modules/$(node -p 'require("./package.json").name')"
bin="$PREFIX/bin/elv"
test -L "$bin" || {
  echo "pack-smoke: $bin is not a symlink; the installed bin shape changed" >&2
  exit 1
}
test -x "$pkgdir/dist/cli.js" || {
  echo "pack-smoke: installed dist/cli.js is not executable" >&2
  exit 1
}

# Production dependencies present, development dependencies absent. Reading both
# lists from package.json keeps this honest as the manifest changes.
node -e '
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const manifest = require(join(process.cwd(), "package.json"));
const modules = join(process.argv[1], "node_modules");
const missing = Object.keys(manifest.dependencies ?? {}).filter((n) => !existsSync(join(modules, n)));
const leaked = Object.keys(manifest.devDependencies ?? {}).filter((n) => existsSync(join(modules, n)));
if (missing.length) {
  console.error("pack-smoke: production dependencies not installed: " + missing.join(", "));
}
if (leaked.length) {
  console.error("pack-smoke: devDependencies present in a production install: " + leaked.join(", "));
}
if (missing.length || leaked.length) process.exit(1);
console.log("pack-smoke: " + Object.keys(manifest.dependencies ?? {}).length + " production dependencies installed, no devDependencies");
' "$pkgdir"

echo "pack-smoke: smoking the installed bin at $bin"
ELV_BIN="$bin" sh "$ROOT/scripts/smoke.sh"
