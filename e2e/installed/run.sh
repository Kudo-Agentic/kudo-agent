#!/usr/bin/env bash
# Runs the /connect snippets verbatim against what users will install:
# `npm pack` tarballs of sdk, mcp and plugin-kudo, published to a throwaway
# local registry (Verdaccio) that proxies npmjs for everything else. Each
# route runs in a clean HOME and directory.
#
#   CONNECT_SNIPPETS=/path/to/kudo-client/src/components/connect/snippets.ts ./installed/run.sh
#
# Needs a fork on :8545 (see ../run.sh), node, bun and the claude CLI logged in.
# Use a fresh fork: Hardhat's forking node has crashed mid-run on long sessions.
# After npm publish, run it with REGISTRY=https://registry.npmjs.org to check
# the real packages instead of the tarballs.
set -uo pipefail
T=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$T/../.." && pwd)
: "${CONNECT_SNIPPETS:?set CONNECT_SNIPPETS to kudo-client/src/components/connect/snippets.ts}"
export CONNECT_SNIPPETS
RPC=http://127.0.0.1:8545
WORK=$(mktemp -d /tmp/kudo-installed-XXXX)
PASS=0; FAIL=0
ok() { if [ "$1" = "1" ]; then PASS=$((PASS+1)); echo "  ✓ $2"; else FAIL=$((FAIL+1)); echo "  ✗ $2"; fi; }
rpc() { curl -s $RPC -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}"; }
snippet() { node --no-warnings -e 'import(process.env.CONNECT_SNIPPETS).then(m=>process.stdout.write(m.CONNECT_OPTIONS.flatMap(o=>o.snippets).find(s=>s.id===process.argv[1]).code))' "$1"; }
cleanup() { kill ${REG_PID:-} 2>/dev/null; }
trap cleanup EXIT

if [ -z "${REGISTRY:-}" ]; then
  echo "=== pack and publish to a local registry"
  ( cd "$ROOT" && npm run build >/dev/null && mkdir -p "$WORK/tgz" && for w in @kudo-dev/sdk @kudo-dev/mcp @kudo-dev/plugin-kudo; do npm pack -w $w --pack-destination "$WORK/tgz" >/dev/null 2>&1 || exit 1; done )
  ls "$WORK/tgz"
  for f in "$WORK"/tgz/*.tgz; do
    HAS_DIST=$(tar -tzf "$f" | grep -c "^package/dist/"); NAMES_TOOLS=$(tar -xOzf "$f" package/package.json | grep -c '@kudo-dev/tools')
    ok "$([ "$HAS_DIST" -gt 0 ] && [ "$NAMES_TOOLS" = 0 ] && echo 1)" "$(basename "$f"): has dist/ ($HAS_DIST files), and its package.json does not name the private @kudo-dev/tools"
  done
  cp "$T/verdaccio.yaml" "$WORK/"
  ( cd "$WORK" && npx -y verdaccio@6 --config ./verdaccio.yaml --listen 4873 > verdaccio.log 2>&1 ) & REG_PID=$!
  for _ in $(seq 1 90); do curl -sf http://127.0.0.1:4873/-/ping >/dev/null && break; sleep 1; done
  REGISTRY=http://127.0.0.1:4873
  TOKEN=$(curl -s -X PUT "$REGISTRY/-/user/org.couchdb.user:e2e" -H 'content-type: application/json' -d '{"name":"e2e","password":"e2e-password"}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).token??""))')
  printf '//127.0.0.1:4873/:_authToken=%s\n' "$TOKEN" > "$WORK/publish.npmrc"
  for f in "$WORK"/tgz/kudo-dev-sdk-*.tgz "$WORK"/tgz/kudo-dev-mcp-*.tgz "$WORK"/tgz/kudo-dev-plugin-kudo-*.tgz; do
    npm publish "$f" --registry $REGISTRY --userconfig "$WORK/publish.npmrc" >/dev/null 2>&1; ok "$([ $? = 0 ] && echo 1)" "published $(basename "$f") to the local registry"
  done
fi
export npm_config_registry=$REGISTRY BUN_CONFIG_REGISTRY=$REGISTRY
echo "registry: $REGISTRY"

# A funded throwaway wallet with an agent id, made with the repo's SDK (setup only).
KEY=$(node -e 'console.log(require("viem/accounts").generatePrivateKey())')
ME=$(node -e 'console.log(require("viem/accounts").privateKeyToAccount(process.argv[1]).address)' $KEY)
rpc hardhat_setBalance "[\"$ME\",\"0xDE0B6B3A7640000\"]" >/dev/null
AGENT_ID=$(cd "$ROOT" && node --input-type=module -e '
  import { createWalletClient, http } from "viem"; import { privateKeyToAccount } from "viem/accounts"; import { createKudo, robinhood } from "@kudo-dev/sdk";
  const chain = { ...robinhood, rpcUrls: { default: { http: [process.argv[2]] } } };
  const k = createKudo({ rpcUrl: process.argv[2], walletClient: createWalletClient({ account: privateKeyToAccount(process.argv[1]), chain, transport: http(process.argv[2]) }) });
  console.log((await k.registerAgent({ name: "Installed Test" })).agentId.toString());' $KEY $RPC)
echo "wallet $ME, agent $AGENT_ID"
fill() { sed -e "s/0x…/$KEY/g" -e "s/=123/=$AGENT_ID/g" -e "s/\"123\"/\"$AGENT_ID\"/g"; }

echo "=== Claude Code: the page's command, in a clean HOME"
CC=$WORK/claude-code; mkdir -p "$CC/home" "$CC/project"
CMD=$(snippet mcp-claude-code | fill | sed "s|claude mcp add kudo |claude mcp add kudo -e KUDO_RPC_URL=$RPC |")
echo "    \$ $(echo "$CMD" | sed "s/$KEY/0x<test key>/")"
( cd "$CC/project" && HOME=$CC/home bash -c "$CMD" ) >/dev/null 2>&1; ok "$([ $? = 0 ] && echo 1)" "claude mcp add succeeded"
LIST=$(cd "$CC/project" && HOME=$CC/home timeout 180 claude mcp list 2>&1)
ok "$(echo "$LIST" | grep -q "kudo.*Connected" && echo 1)" "claude mcp list: $(echo "$LIST" | grep kudo | sed "s/$KEY/0x<key>/" | cut -c1-110)"
OUT=$(cd "$CC/project" && HOME=$CC/home timeout 900 claude -p --model sonnet --allowedTools=mcp__kudo -- "Use the Kudo MCP tools. Mint an INVOICE covenant under my agent $AGENT_ID: the counterparty writes a 200-word ERC-8004 note on IPFS; I pay 2 USDG within one hour of the link going up. Don't ask me to confirm, just mint it and give me the covenant id." 2>&1)
N=$(cd "$ROOT" && node --input-type=module -e 'import { createKudo } from "@kudo-dev/sdk"; const l = await createKudo({ rpcUrl: process.argv[2] }).listCovenants({ agentWallet: process.argv[1] }); console.log(l.length + " " + (l[0]?.promise ?? ""))' $ME $RPC)
echo "$OUT" | tail -4 | sed 's/^/    Claude: /'
ok "$(echo "$N" | grep -q '^1 .*2 USDG' && echo 1)" "Claude Code minted through the installed server (chain: $N)"

echo "=== Claude Desktop / Cursor / Windsurf JSON and Codex TOML"
CL=$WORK/clients; mkdir -p "$CL/home"; cp "$T/clients.mjs" "$T/snippets.mjs" "$CL/"
( cd "$CL" && echo '{"type":"module","private":true}' > package.json && HOME=$CL/home npm i --no-audit --no-fund @modelcontextprotocol/sdk smol-toml >/dev/null 2>&1 )
OUT=$(cd "$CL" && HOME=$CL/home node --no-warnings clients.mjs $KEY $AGENT_ID $RPC 2>&1); echo "$OUT" | sed "s/$KEY/0x<key>/g"
ok "$([ $? = 0 ] && ! echo "$OUT" | grep -q "✗" && echo 1)" "each MCP client config parses and starts the installed server"

echo "=== kudo-mcp --http from the installed package, with a key set"
HT=$WORK/http; mkdir -p "$HT/home"
( cd "$HT" && echo '{"private":true}' > package.json && HOME=$HT/home npm i --no-audit --no-fund @kudo-dev/mcp >/dev/null 2>&1 )
OUT=$(node "$T/../http-refuses-signing.mjs" "$HT/node_modules/.bin/kudo-mcp" 2>&1); echo "$OUT" | sed 's/^/  /'
ok "$(echo "$OUT" | grep -q "all checks passed" && echo 1)" "the installed HTTP server refuses to sign"

echo "=== ElizaOS: bun add, then the page's character"
EL=$WORK/eliza; mkdir -p "$EL/home"; cp "$T/eliza.ts" "$T/snippets.mjs" "$T/../eliza/src/claude-model.ts" "$EL/"
( cd "$EL" && echo '{"name":"installed-eliza","type":"module","private":true}' > package.json )
INSTALL=$(snippet eliza-install)
echo "    \$ $INSTALL"
( cd "$EL" && HOME=$EL/home bash -c "$INSTALL" >/dev/null 2>&1 ); ok "$([ $? = 0 ] && [ -d "$EL/node_modules/@kudo-dev/plugin-kudo/dist" ] && echo 1)" "bun add @kudo-dev/plugin-kudo installed the tarball"
( cd "$EL" && HOME=$EL/home bun add @elizaos/core@1.7.2 @elizaos/plugin-bootstrap@1.7.2 @elizaos/plugin-sql@1.7.2 @kudo-dev/sdk viem >/dev/null 2>&1 )
OUT=$(cd "$EL" && HOME=$EL/home PGLITE_DATA_DIR=$EL/.db timeout 1800 bun eliza.ts $KEY $RPC 2>&1 | grep -E "^  (✓|✗) "); echo "$OUT"
# Every expected check must be there: a crash or a dead fork prints fewer lines.
ok "$([ "$(echo "$OUT" | grep -c "^  ✓ ")" = 3 ] && ! echo "$OUT" | grep -q "✗" && echo 1)" "the character from the page runs the installed plugin (3/3 checks printed and passed)"

echo "$PASS passed, $FAIL failed  (work dir $WORK)"
[ "$FAIL" = 0 ]
