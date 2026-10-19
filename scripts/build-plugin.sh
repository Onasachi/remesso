#!/usr/bin/env bash
# Assemble plugin/ — the Claude plugin as the directory ships it — from the
# files that are maintained elsewhere in the repo:
#
#   skills/{remesso,remesso-x402,remesso-wallet}  ->  plugin/skills/
#   mcp/dist/server.mjs (npm run build in mcp/)   ->  plugin/mcp/server.mjs
#   mcp/src, scripts, package.json, lockfile      ->  plugin/mcp/ (readable source, to rebuild and compare)
#   web/app/icon.png, LICENSE                     ->  plugin/
#
# Why a folder of its own: with the repo root as the plugin, the directory's
# validator reads all of it — the web app, the contracts and their submodules,
# scripts that read .env — and holds the plugin over files it never ships.
#
# plugin/.claude-plugin/plugin.json and plugin/README.md are edited in place.
#
#   scripts/build-plugin.sh          write plugin/
#   scripts/build-plugin.sh --check  exit 1 if plugin/ differs from its sources
set -euo pipefail
cd "$(dirname "$0")/.."

assemble() {
  local out="$1"
  mkdir -p "$out/skills" "$out/mcp/src" "$out/.claude-plugin"
  for s in remesso remesso-x402 remesso-wallet; do
    rm -rf "$out/skills/$s"
    mkdir -p "$out/skills/$s"
    cp "skills/$s/SKILL.md" "$out/skills/$s/"
    [ -f "skills/$s/manifest.json" ] && cp "skills/$s/manifest.json" "$out/skills/$s/"
    [ -d "skills/$s/scripts" ] && cp -R "skills/$s/scripts" "$out/skills/$s/"
  done
  cp mcp/dist/server.mjs "$out/mcp/server.mjs"
  cp mcp/src/server.mjs mcp/src/mcp.mjs "$out/mcp/src/"
  cp mcp/package.json mcp/package-lock.json "$out/mcp/"
  mkdir -p "$out/mcp/scripts" && cp mcp/scripts/strip-bytecode.mjs "$out/mcp/scripts/"
  cp web/app/icon.png "$out/.claude-plugin/icon.png"
  cp LICENSE "$out/LICENSE"
}

if [ "${1:-}" = "--check" ]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  cp -R plugin/. "$tmp/"
  assemble "$tmp"
  if diff -r plugin "$tmp" >/dev/null; then echo "plugin/: current"; else
    echo "plugin/: out of date — run scripts/build-plugin.sh"; diff -rq plugin "$tmp" || true; exit 1
  fi
else
  assemble plugin
  echo "plugin/: written"
fi
