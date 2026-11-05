#!/bin/sh
# Removes from node_modules what never runs in the container (called in the Dockerfile).
# Usage: sh prune-modules.sh <node_modules>
set -eu
M="${1:?node_modules folder missing}"
[ -d "$M" ] || { echo "prune-modules: $M not found" >&2; exit 1; }
before="$(du -sk "$M" | cut -f1)"

# better-sqlite3: keep only the binary that is loaded on this platform
B="$M/better-sqlite3"
if [ -d "$B" ]; then
  arch="$(node -p process.arch)"
  libc=linux
  # Alpine/musl: lib/binding.js chooses "linuxmusl-<arch>"
  if [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ]; then libc=linuxmusl; fi
  keep="$libc-$arch.node"
  if [ -f "$B/prebuilds/$keep" ]; then
    find "$B/prebuilds" -type f ! -name "$keep" -exec rm -f {} +
    rm -rf "$B/build"
  elif [ -f "$B/build/Release/better_sqlite3.node" ]; then
    # self-built (no prebuilt binary): keep only the result
    rm -rf "$B/prebuilds"
    find "$B/build" -mindepth 1 -maxdepth 1 ! -name Release -exec rm -rf {} +
    find "$B/build/Release" -mindepth 1 -maxdepth 1 ! -name better_sqlite3.node -exec rm -rf {} +
  else
    echo "prune-modules: no better-sqlite3 binary for $keep found" >&2
    exit 1
  fi
  # Sources and build files of SQLite and the driver
  rm -rf "$B/deps" "$B/src" "$B/binding.gyp"
fi

# Tests, docs and examples of the packages
find "$M" -depth -type d \( -name test -o -name tests -o -name __tests__ -o -name docs \
  -o -name example -o -name examples -o -name .github \) -exec rm -rf {} +
find "$M" -type f \( -name '*.md' -o -name '*.markdown' -o -name '*.map' -o -name '*.ts' \
  -o -name '.eslintrc*' -o -name '.prettierrc*' -o -name '.editorconfig' -o -name '.travis.yml' \) \
  ! -iname 'LICENSE*' ! -iname 'LICENCE*' -exec rm -f {} +

after="$(du -sk "$M" | cut -f1)"
echo "prune-modules: node_modules ${before} KB -> ${after} KB"
