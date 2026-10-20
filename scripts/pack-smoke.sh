#!/usr/bin/env bash
# Pack this package from a fresh clone of HEAD (so only committed files count), install the
# tarball into an empty project, and import every entry point it exports.
# Optional: a command to run inside that project afterwards, with $SRC set to the clean clone,
# e.g.  scripts/pack-smoke.sh 'npx --no-install mytool --help'
set -euo pipefail
root=$(git rev-parse --show-toplevel)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git clone --quiet "$root" "$work/src"
(cd "$work/src" && npm ci --silent --no-audit --no-fund && npm pack --silent --pack-destination "$work" >/dev/null)
tgz=$(ls "$work"/*.tgz)
echo "packed $(basename "$tgz")"
mkdir "$work/app"
cd "$work/app"
npm init -y >/dev/null
npm install --silent --no-audit --no-fund "$tgz"
name=$(node -p "require('$work/src/package.json').name")
PKG="$name" node --input-type=module -e '
import { readFile } from "node:fs/promises";
const name = process.env.PKG;
const pkg = JSON.parse(await readFile(`node_modules/${name}/package.json`, "utf8"));
const ex = pkg.exports;
const subs = !ex || typeof ex === "string" || Object.keys(ex).every((k) => !k.startsWith("."))
  ? ["."]
  : Object.keys(ex).filter((k) => !k.includes("*") && !k.endsWith(".json"));
for (const s of subs) {
  const spec = s === "." ? name : name + s.slice(1);
  await import(spec);
  console.log("import ok:", spec);
}
'
if [ $# -gt 0 ]; then SRC="$work/src" bash -c "$1"; fi
echo "pack smoke OK"
