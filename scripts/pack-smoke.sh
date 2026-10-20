#!/usr/bin/env bash
# Pack this package from a fresh clone of HEAD (only committed files count), install the tarball
# into an empty project, and prove it works the way a user gets it:
#   1. the tarball contains dist/ and every file that main, types, exports and bin point at;
#   2. every entry point imports and has at least one named export;
#   3. every bin, run through the installed symlink with --help, prints something (stdout or stderr;
#      the stream and exit code are recorded so a usage error is visible as such).
# Usage: scripts/pack-smoke.sh ['<extra command run in the app dir, with $SRC = clean clone>']
# PKG_DIR=<subdir> packs a package that lives below the repo root (for example packages/sdk-ts).
set -euo pipefail
root=$(git rev-parse --show-toplevel)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git clone --quiet "$root" "$work/src"
pkgdir="$work/src/${PKG_DIR:-.}"
(cd "$work/src" && npm ci --silent --no-audit --no-fund)
(cd "$pkgdir" && npm pack --silent --pack-destination "$work" >/dev/null)
tgz=$(ls "$work"/*.tgz)
tar tzf "$tgz" | sed 's#^package/##' | sort > "$work/files.txt"
echo "packed $(basename "$tgz"): $(wc -l < "$work/files.txt") files, $(grep -c '^dist/' "$work/files.txt" || true) under dist/"
mkdir "$work/app"
cd "$work/app"
npm init -y >/dev/null
npm install --silent --no-audit --no-fund "$tgz"
name=$(node -p "require('$pkgdir/package.json').name")
FILES="$work/files.txt" PKG="$name" node --input-type=module -e '
import { readFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
const name = process.env.PKG;
const files = new Set((await readFile(process.env.FILES, "utf8")).split("\n").filter(Boolean));
const pkg = JSON.parse(await readFile(`node_modules/${name}/package.json`, "utf8"));
const fail = (m) => { console.error("PACK SMOKE FAIL:", m); process.exit(1); };
// 1. dist/ and every referenced file are in the tarball
if (![...files].some((f) => f.startsWith("dist/"))) fail("no dist/ in the tarball");
const refs = [];
const walk = (v) => { if (typeof v === "string") refs.push(v); else if (v && typeof v === "object") Object.values(v).forEach(walk); };
walk(pkg.main); walk(pkg.types); walk(pkg.exports);
const bins = typeof pkg.bin === "string" ? { [name.split("/").pop()]: pkg.bin } : (pkg.bin ?? {});
walk(bins);
for (const r of refs) {
  if (r.includes("*")) continue;
  const f = r.replace(/^\.\//, "");
  if (!files.has(f)) fail(`${r} is referenced in package.json but not in the tarball`);
}
console.log(`tarball ok: dist/ present, ${refs.length} referenced files present`);
// 2. every entry point imports with a named export
const ex = pkg.exports;
const subs = !ex || typeof ex === "string" || Object.keys(ex).every((k) => !k.startsWith("."))
  ? ["."]
  : Object.keys(ex).filter((k) => !k.includes("*") && !k.endsWith(".json"));
for (const s of subs) {
  const spec = s === "." ? name : name + s.slice(1);
  const m = await import(spec);
  const named = Object.keys(m).filter((k) => k !== "default");
  if (named.length === 0) fail(`${spec} has no named export`);
  console.log(`import ok: ${spec} (${named.length} named exports, e.g. ${named[0]})`);
}
// 3. every bin prints help through the installed symlink
for (const b of Object.keys(bins)) {
  // Node runtime warnings are not output from the bin: suppress them, and drop any that still appear,
  // so a silent no-op (BB-R1) cannot pass on an ExperimentalWarning alone.
  const r = spawnSync(`node_modules/.bin/${b}`, ["--help"], { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  r.stderr = r.stderr.split("\n").filter((l) => !/^\(node:\d+\) |^\(Use `node --trace-/.test(l)).join("\n");
  const code = r.status ?? `signal ${r.signal}`;
  const stream = r.stdout.trim() ? "stdout" : r.stderr.trim() ? "stderr" : "";
  if (!stream) fail(`bin ${b} --help printed nothing (exit ${code})`);
  const out = stream === "stdout" ? r.stdout : r.stderr;
  console.log(`bin ok: ${b} --help exit ${code}, ${out.length} bytes on ${stream}: ${out.trim().split("\n")[0].slice(0, 90)}`);
}
if (Object.keys(bins).length === 0) console.log("bins: none declared");
'
if [ $# -gt 0 ]; then SRC="$work/src" bash -c "$1"; fi
echo "pack smoke OK"
