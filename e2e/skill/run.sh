#!/usr/bin/env bash
# Prerequisite: a Prague fork on :8545, from e2e/:
#   npx hardhat node --config skill/hardhat.prague.cjs --port 8545
# then warm it (see ../run.sh) and run ./skill/run.sh as root (it serves /var/run/dstack.sock).
# Use a fresh fork each time: the stand-in dstack key is deterministic, so on a
# reused fork Ada is already registered and the first check reads differently.
# Runs the code blocks of skills/kudo/SKILL.md verbatim against a Prague fork
# of Robinhood mainnet, with a stand-in Alchemy bundler and a stand-in dstack.
set -uo pipefail
T=$(cd "$(dirname "$0")" && pwd)
SKILL=$(cd "$T/../../skills/kudo" && pwd)/SKILL.md
command -v cast >/dev/null || { echo "cast is not on PATH (npm i -g @foundry-rs/cast)"; exit 1; }
node "$T/rpc-proxy.mjs" 2>/dev/null & PROXY_PID=$!; sleep 1
export HOME=$T/home RPC_URL=http://127.0.0.1:8546 BUNDLER_URL=http://127.0.0.1:4337 GAS_POLICY_ID=test-policy
mkdir -p "$HOME" "$T/blocks"
CARTE=0xFB9A9eB13B4Cf30963DCC0A0cbc5598Cc03B2cf3
PASS=0; FAIL=0
ok() { if [ "$1" = "1" ]; then PASS=$((PASS+1)); echo "  ✓ $2"; else FAIL=$((FAIL+1)); echo "  ✗ $2"; fi; }
rpc() { curl -s $RPC_URL -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}"; }

# --- extract the skill's blocks exactly as written ------------------------------
node -e '
const fs=require("fs");const md=fs.readFileSync(process.argv[1],"utf8");
for (const m of md.matchAll(/```bash\n([\s\S]*?)```/g)) {
  const b=m[1]; const first=b.split("\n")[0];
  if (first.startsWith("# kudo.sh")) fs.writeFileSync(process.argv[2]+"/kudo.sh", b);
  const step=first.match(/^# step: (\S+)/); if (step) fs.writeFileSync(process.argv[3]+"/"+step[1]+".sh", b);
}' "$SKILL" "$HOME" "$T/blocks"
ls "$T/blocks" | tr '\n' ' '; echo
source "$HOME/kudo.sh"   # for the test's own reads
step() { bash "$T/blocks/$1.sh" 2>&1; }

start_dstack() { node "$T/mock-dstack.mjs" 2>/dev/null & DSTACK_PID=$!; sleep 1; }
stop_dstack()  { kill $DSTACK_PID 2>/dev/null; sleep 0.5; rm -f /var/run/dstack.sock; }

node "$T/mock-bundler.mjs" 2>"$T/bundler.log" & BUNDLER_PID=$!
trap 'kill $PROXY_PID $BUNDLER_PID $DSTACK_PID 2>/dev/null; rm -f /var/run/dstack.sock' EXIT
sleep 1

echo "=== Ada: in a Phala TEE (dstack), sponsored gas, no ETH ==="
start_dstack
unset PRIVATE_KEY
export AGENT_NAME=Ada
ADA=$(kudo_address); APP=$(kudo_tee_id)
ok "$([ "$(cast balance $ADA --rpc-url $RPC_URL)" = "0" ] && echo 1)" "Ada's dstack-derived wallet $ADA holds 0 ETH"
OUT=$(step startup); echo "$OUT" | sed 's/^/    /'
ADA_ID=$(echo "$OUT" | sed -n 's/^AGENT_ID=//p')
ok "$(echo "$OUT" | grep -q "registered agent" && echo 1)" "startup registered a new identity ($ADA_ID)"
ok "$([ "$(cast call $IDENTITY_REGISTRY 'ownerOf(uint256)(address)' $ADA_ID --rpc-url $RPC_URL)" = "$ADA" ] && echo 1)" "identity owned by Ada's wallet"
ok "$([ "$(cast call $IDENTITY_REGISTRY 'getMetadata(uint256,string)(bytes)' $ADA_ID teeId --rpc-url $RPC_URL | cast to-ascii)" = "$APP" ] && echo 1)" "teeId on chain = dstack app id ($APP)"
ok "$(cast code $ADA --rpc-url $RPC_URL | grep -qi '0xef010077021100bd87b7008e5e1989d0eb38555d0d0000' && echo 1)" "wallet delegated to Modular Account v2 by its first UserOperation"
ok "$([ "$(cast balance $ADA --rpc-url $RPC_URL)" = "0" ] && echo 1)" "still 0 ETH: gas was sponsored"

OUT=$(step startup); echo "$OUT" | sed 's/^/    /'
ok "$(echo "$OUT" | grep -q "already registered as agent $ADA_ID" && ! echo "$OUT" | grep -q teeId && echo 1)" "second start: recovers the id, nothing rewritten"

source "$HOME/kudo.sh"
kudo_send $IDENTITY_REGISTRY "$(cast calldata 'setMetadata(uint256,string,bytes)' $ADA_ID teeId "$(cast from-utf8 stale-app-id)")" >/dev/null
OUT=$(step startup); echo "$OUT" | sed 's/^/    /'
ok "$(echo "$OUT" | grep -q "teeId updated" && [ "$(cast call $IDENTITY_REGISTRY 'getMetadata(uint256,string)(bytes)' $ADA_ID teeId --rpc-url $RPC_URL | cast to-ascii)" = "$APP" ] && echo 1)" "stale teeId overwritten at startup"

OUT=$(AGENT_ID=$ADA_ID step mint); echo "$OUT" | sed 's/^/    /'
COV=$(echo "$OUT" | sed -n 's/^minted covenant \([0-9]*\):.*/\1/p')
C=$(cast call $KUDO 'getCovenant(uint256)((address,uint256,uint8,string,string,string,string,string,uint256,string))' $COV --rpc-url $RPC_URL --json)
ok "$(echo "$C" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s)[0];console.log(c[3]==="INVOICE"&&c[5]==="I'"'"'ll pay 5 USDG within one hour of the link going up."&&String(c[1])===process.argv[1]?1:0)})' $ADA_ID)" "minted covenant $COV under agent $ADA_ID, apostrophe intact"
OUT=$(step read)
ok "$(! echo "$OUT" | grep -q "^#$COV " && echo 1)" "Ada's own covenant is not in her open asks"
stop_dstack

echo "=== Bob: no TEE, PRIVATE_KEY, sponsored gas, no ETH ==="
export PRIVATE_KEY=$(cast wallet new --json | kudo_json 0.private_key) AGENT_NAME=Bob
BOB=$(cast wallet address --private-key $PRIVATE_KEY)
OUT=$(step startup); echo "$OUT" | sed 's/^/    /'
BOB_ID=$(echo "$OUT" | sed -n 's/^AGENT_ID=//p')
ok "$(echo "$OUT" | grep -q "registered agent" && [ "$(cast call $IDENTITY_REGISTRY 'getMetadata(uint256,string)(bytes)' $BOB_ID teeId --rpc-url $RPC_URL)" = "0x" ] && echo 1)" "Bob registered ($BOB_ID) with no teeId"
OUT=$(step read)
ok "$(echo "$OUT" | grep -q "^#$COV INVOICE" && echo 1)" "Ada's covenant is in Bob's open asks"
sed "s|^ID=113|ID=$COV|; s|^PROOF=.*|PROOF=\"https://ipfs.io/ipfs/bafkreia47kzwlipoeycokourgsngbommecsp5ap7zcpuqdybzknoxepkxm\"|" "$T/blocks/meet.sh" > "$T/blocks/meet.run.sh"
OUT=$(bash "$T/blocks/meet.run.sh" 2>&1); echo "$OUT" | sed 's/^/    /'
C=$(cast call $KUDO 'getCovenant(uint256)((address,uint256,uint8,string,string,string,string,string,uint256,string))' $COV --rpc-url $RPC_URL --json)
ok "$(echo "$C" | grep -q "pay: $BOB" && echo "$C" | grep -q bafkreia47kz && echo 1)" "Bob met the ask with proof and 'pay: $BOB'"
OUT=$(bash "$T/blocks/meet.run.sh" 2>&1)
ok "$(echo "$OUT" | grep -q "already taken" && echo 1)" "meeting it again is refused"
ok "$([ "$(cast balance $BOB --rpc-url $RPC_URL)" = "0" ] && echo 1)" "Bob still has 0 ETH"
unset PRIVATE_KEY

echo "=== Ada keeps her promise (TEE again) ==="
start_dstack
rpc hardhat_impersonateAccount "[\"$CARTE\"]" >/dev/null; rpc hardhat_setBalance "[\"$CARTE\",\"0xDE0B6B3A7640000\"]" >/dev/null
rpc eth_sendTransaction "[{\"from\":\"$CARTE\",\"to\":\"$USDG\",\"data\":\"$(cast calldata 'transfer(address,uint256)' $ADA 10000000)\"}]" >/dev/null
BEFORE=$(cast call $USDG 'balanceOf(address)(uint256)' $BOB --rpc-url $RPC_URL | cut -d' ' -f1)
sed "s|^ID=113|ID=$COV|; s|^PAYEE=0x0000000000000000000000000000000000000000|PAYEE=$BOB|" "$T/blocks/keep.sh" > "$T/blocks/keep.run.sh"
OUT=$(bash "$T/blocks/keep.run.sh" 2>&1); echo "$OUT" | sed 's/^/    /'
AFTER=$(cast call $USDG 'balanceOf(address)(uint256)' $BOB --rpc-url $RPC_URL | cut -d' ' -f1)
ok "$([ $((AFTER - BEFORE)) = 5000000 ] && echo 1)" "Bob received exactly 5 USDG (5000000 base units)"
PAYHASH=$(echo "$OUT" | sed -n 's/^paid 5 USDG in \(0x[0-9a-f]*\) .*/\1/p')
C=$(cast call $KUDO 'getCovenant(uint256)((address,uint256,uint8,string,string,string,string,string,uint256,string))' $COV --rpc-url $RPC_URL --json)
ok "$(echo "$C" | grep -q "\"$PAYHASH\"" && echo 1)" "promise proof on chain is the payment's tx hash"
ok "$([ "$(cast balance $ADA --rpc-url $RPC_URL)" = "0" ] && echo 1)" "Ada still has 0 ETH"
stop_dstack

echo "=== Fallback: no BUNDLER_URL, plain cast send with ETH ==="
export PRIVATE_KEY=$(cast wallet new --json | kudo_json 0.private_key) AGENT_NAME=Carl
CARL=$(cast wallet address --private-key $PRIVATE_KEY)
rpc hardhat_setBalance "[\"$CARL\",\"0xDE0B6B3A7640000\"]" >/dev/null
OUT=$(BUNDLER_URL= step startup); echo "$OUT" | sed 's/^/    /'
ok "$(echo "$OUT" | grep -q "registered agent" && [ "$(cast code $CARL --rpc-url $RPC_URL)" = "0x" ] && echo 1)" "registered with an ordinary transaction, no delegation"

echo "=== bundler stand-in saw ==="
grep -c "" "$T/bundler.log" >/dev/null; cat "$T/bundler.log"
echo "$PASS passed, $FAIL failed"
