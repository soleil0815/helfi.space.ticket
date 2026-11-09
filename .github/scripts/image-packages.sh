#!/bin/sh
# What is inside an image: Alpine release and packages, Node version, npm packages – one sorted line each.
# The security update compares this list of the new build with the published image: equal = nothing to do.
# Usage: sh .github/scripts/image-packages.sh <image> [platform, e.g. linux/arm64]
set -eu
img="${1:?image}"
platform="${2:-}"

set -- docker run --rm --network none --entrypoint sh
[ -z "$platform" ] || set -- "$@" --platform "$platform"
# shellcheck disable=SC2016 # expanded inside the container
"$@" "$img" -c '
  echo "alpine $(cat /etc/alpine-release)"
  apk info -v 2>/dev/null | sed "s/^/apk /"
  echo "node $(node -v)"
  node -e "
    const fs = require(\"fs\"), path = require(\"path\");
    const walk = (dir) => {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { return; }
      for (const n of names) {
        if (n.startsWith(\".\")) continue;
        const d = path.join(dir, n);
        if (n.startsWith(\"@\")) { walk(d); continue; }
        try {
          const p = JSON.parse(fs.readFileSync(path.join(d, \"package.json\"), \"utf8\"));
          if (p.name && p.version) console.log(\"npm \" + p.name + \"@\" + p.version);
        } catch {}
        walk(path.join(d, \"node_modules\"));
      }
    };
    walk(\"/app/node_modules\");
  "
' | sort -u
