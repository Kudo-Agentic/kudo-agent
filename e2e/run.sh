#!/usr/bin/env bash
# Forks Robinhood Chain mainnet locally and runs every package's write path
# with real signatures. Nothing touches mainnet. Build the packages first:
#   (cd .. && npm install && npm run build) && npm install && npm test
set -euo pipefail
cd "$(dirname "$0")"
RPC=http://127.0.0.1:8545
npx hardhat node --config hardhat.config.cjs --port 8545 > hardhat.log 2>&1 &
NODE_PID=$!
trap 'kill $NODE_PID 2>/dev/null' EXIT
for _ in $(seq 1 60); do
  curl -sf $RPC -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' >/dev/null && break
  sleep 1
done
call() { curl -s -m 600 $RPC -H 'content-type: application/json' -d "$1" >/dev/null; }
# Reads at the fork block itself are refused; move one block past it.
call '{"jsonrpc":"2.0","id":1,"method":"evm_mine","params":[]}'
# The fork fetches storage lazily; listing every covenant the first time takes
# minutes, so warm it once rather than letting a test time out.
echo "warming the fork (first read of every covenant, a few minutes)…"
call '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x1930D0FEaB14b024353bF22adE03Db989aD640C7","data":"0x5ebf5a42"},"latest"]}'
node lifecycle.mjs
node frontends.mjs
echo "all end-to-end checks passed"
