#!/usr/bin/env bash
# Set V5's allowlists to match V4's, from V5's owner, each transaction
# carrying the ERC-8021 attribution suffix (remesso + celo_5cd35ca55baf).
#
#   script/setup-v5.sh 0x<V5 address>      (from contracts/)
#
# Separate from DeployV5.s.sol because a creation transaction cannot carry the
# suffix (trailing init-code bytes are read as constructor arguments), and an
# untagged transaction can never be attributed later. The suffix is what
# `supabase/functions/_shared/attribution.ts` produces for the default codes;
# `attribution.test.ts` pins that output to the SDK's own.
#
# The owner key is DEPLOYER_PRIVATE_KEY from contracts/.env — the key that
# deployed V5 and so owns it. Read into this process only, never echoed.
set -euo pipefail
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

V5="${1:?usage: setup-v5.sh 0x<V5 address>}"
RPC="${CELO_RPC_URL:-https://forno.celo.org}"
SUFFIX=72656d6573736f2c63656c6f5f356364333563613535626166190080218021802180218021802180218021
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PK="$(grep '^DEPLOYER_PRIVATE_KEY=' "$HERE/.env" | cut -d= -f2-)"
me="$(cast wallet address --private-key "$PK")"

owner="$(cast call "$V5" 'owner()(address)' --rpc-url "$RPC")"
[ "$(echo "$owner" | tr A-F a-f)" = "$(echo "$me" | tr A-F a-f)" ] \
  || { echo "V5 owner is $owner, but contracts/.env holds the key for $me — refusing"; exit 1; }

# The nonce is tracked here, not asked of the RPC per send: forno is load
# balanced, and a node a block behind reports a stale next nonce, which failed
# two of the first run's ten sends with "nonce too low" (2026-10-16).
NONCE="$(cast nonce "$me" --rpc-url "$RPC")"

# Prints its own result and must be called directly, never inside $(…): a
# command substitution is a subshell, and the nonce increment would be lost
# with it — which is how the second run reused a nonce.
send() { # fn-signature args...
  local data out
  data="$(cast calldata "$@")${SUFFIX}"
  out="$(cast send "$V5" "$data" --private-key "$PK" --rpc-url "$RPC" --nonce "$NONCE" --json)"
  NONCE=$((NONCE + 1))
  echo "$out" | jq -r '"\(.transactionHash) \(.status)"'
}

# Idempotent: an entry already set is skipped, so a re-run after a partial
# failure sends only what is missing.
allow() { # getter setter token label
  if [ "$(cast call "$V5" "$1(address)(bool)" "$3" --rpc-url "$RPC")" = "true" ]; then
    echo "$2 $4: already set"
  else
    printf '%s %s: ' "$2" "$4"
    send "$2(address,bool)" "$3" true
  fi
}

# Direct rail: everything V4 allows (read on-chain 2026-10-16).
allow directTokenAllowed setDirectToken 0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e "USDT  6dp"
allow directTokenAllowed setDirectToken 0xcebA9300f2b948710d2653dD7B07f33A8B32118C "USDC  6dp"
allow directTokenAllowed setDirectToken 0x765DE816845861e75A25fCA122bb6898B8B1282a "USDm 18dp"
allow directTokenAllowed setDirectToken 0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771 "USA₮  6dp"
allow directTokenAllowed setDirectToken 0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D "wARS 18dp"
allow directTokenAllowed setDirectToken 0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0 "wBRL 18dp"
allow directTokenAllowed setDirectToken 0x8a1D45e102e886510e891d2Ec656a708991e2D76 "wCOP 18dp"
allow directTokenAllowed setDirectToken 0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f "cNGN  6dp"

# Swap-rail payouts beyond the constructor's cNGN.
allow swapTokenAllowed setSwapToken 0xcebA9300f2b948710d2653dD7B07f33A8B32118C "USDC"
allow swapTokenAllowed setSwapToken 0x765DE816845861e75A25fCA122bb6898B8B1282a "USDm"

echo "done. feeBps=$(cast call "$V5" 'feeBps()(uint16)' --rpc-url "$RPC") executor=$(cast call "$V5" 'executor()(address)' --rpc-url "$RPC")"
