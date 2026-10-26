#!/usr/bin/env bash
# Assemble plugin/ — the Claude plugin as the directory ships it — from the
# files that are maintained elsewhere in the repo:
#
#   skills/{remesso,remesso-x402,remesso-wallet,remesso-sdk}  ->  plugin/skills/
#   mcp/dist/server.mjs (npm run build in mcp/)   ->  plugin/mcp/server.mjs
#   mcp/src, scripts, package.json, lockfile      ->  plugin/mcp/ (readable source, to rebuild and compare)
#   the SDK source the wallet's bundle reads      ->  plugin/packages/remesso-sdk/src/ (same relative path)
#   web/app/icon.png, LICENSE                     ->  plugin/
#
# and the npm package for Codex, Cursor and other MCP hosts from the same files:
#
#   mcp/dist/server.mjs, skills, LICENSE          ->  packages/remesso-wallet/
#
# packages/remesso-wallet/{package.json,cli.mjs,README.md} are edited in place.
#
# Why a folder of its own: with the repo root as the plugin, the directory's
# validator reads all of it — the web app, the contracts and their submodules,
# scripts that read .env — and holds the plugin over files it never ships.
#
# plugin/.claude-plugin/plugin.json, plugin/README.md and plugin/commands/ are edited in place.
#
#   scripts/build-plugin.sh          write plugin/
#   scripts/build-plugin.sh --check  exit 1 if plugin/ differs from its sources
set -euo pipefail
cd "$(dirname "$0")/.."

# The SDK files the wallet's bundle is built from, as esbuild resolves them:
# the dev tool, CLI and Postgres adapter aren't among them and don't ship.
sdk_inputs() {
  local meta
  meta="$(mktemp)"
  (cd mcp && node_modules/.bin/esbuild src/server.mjs --bundle --alias:viem=viem --platform=node --format=esm \
    --target=node20 --metafile="$meta" --outfile=/dev/null --log-level=error)
  node -e 'const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const p of Object.keys(m.inputs).sort()) if (p.startsWith("../packages/remesso-sdk/src/")) console.log(p.slice(3));' "$meta"
  rm -f "$meta"
}

assemble() {
  local out="$1"
  mkdir -p "$out/skills" "$out/mcp/src" "$out/.claude-plugin"
  for s in remesso remesso-x402 remesso-wallet remesso-sdk; do
    rm -rf "$out/skills/$s"
    mkdir -p "$out/skills/$s"
    cp "skills/$s/SKILL.md" "$out/skills/$s/"
    [ -f "skills/$s/manifest.json" ] && cp "skills/$s/manifest.json" "$out/skills/$s/"
    [ -d "skills/$s/scripts" ] && cp -R "skills/$s/scripts" "$out/skills/$s/"
    [ -d "skills/$s/references" ] && cp -R "skills/$s/references" "$out/skills/$s/"
  done
  cp mcp/dist/server.mjs "$out/mcp/server.mjs"
  rm -rf "$out/mcp/src" && mkdir -p "$out/mcp/src" && cp mcp/src/*.mjs "$out/mcp/src/"
  # The wallet imports the SDK's source by relative path; this keeps that
  # path working in plugin/, so `npm ci && npm run build` there is complete.
  rm -rf "$out/packages"
  for f in $(sdk_inputs); do
    mkdir -p "$out/$(dirname "$f")"
    cp "$f" "$out/$f"
  done
  # Its "sideEffects": false is what lets esbuild leave unused SDK modules out.
  cp packages/remesso-sdk/package.json "$out/packages/remesso-sdk/package.json"
  cp mcp/package.json mcp/package-lock.json "$out/mcp/"
  mkdir -p "$out/mcp/scripts" && cp mcp/scripts/strip-bytecode.mjs "$out/mcp/scripts/"
  cp web/app/icon.png "$out/.claude-plugin/icon.png"
  cp LICENSE "$out/LICENSE"
}

assemble_npm() {
  local out="$1"
  mkdir -p "$out/skills"
  for s in remesso remesso-x402 remesso-wallet remesso-sdk; do
    rm -rf "$out/skills/$s"
    mkdir -p "$out/skills/$s"
    cp "skills/$s/SKILL.md" "$out/skills/$s/"
    [ -f "skills/$s/manifest.json" ] && cp "skills/$s/manifest.json" "$out/skills/$s/"
    [ -d "skills/$s/scripts" ] && cp -R "skills/$s/scripts" "$out/skills/$s/"
    [ -d "skills/$s/references" ] && cp -R "skills/$s/references" "$out/skills/$s/"
  done
  cp mcp/dist/server.mjs "$out/server.mjs"
  cp LICENSE "$out/LICENSE"
}

if [ "${1:-}" = "--check" ]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  cp -R plugin/. "$tmp/"
  assemble "$tmp"
  mkdir -p "$tmp.npm" && trap 'rm -rf "$tmp" "$tmp.npm"' EXIT
  cp -R packages/remesso-wallet/. "$tmp.npm/"
  assemble_npm "$tmp.npm"
  stale=0
  if diff -r plugin "$tmp" >/dev/null; then echo "plugin/: current"; else
    echo "plugin/: out of date — run scripts/build-plugin.sh"; diff -rq plugin "$tmp" || true; stale=1
  fi
  if diff -r packages/remesso-wallet "$tmp.npm" >/dev/null; then echo "packages/remesso-wallet/: current"; else
    echo "packages/remesso-wallet/: out of date — run scripts/build-plugin.sh"; diff -rq packages/remesso-wallet "$tmp.npm" || true; stale=1
  fi
  exit $stale
else
  assemble plugin
  echo "plugin/: written"
  assemble_npm packages/remesso-wallet
  echo "packages/remesso-wallet/: written"
fi
