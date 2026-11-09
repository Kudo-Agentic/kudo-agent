#!/usr/bin/env bash
# Prerequisite: a fork on :8545, from e2e/:
#   npx hardhat node --config hardhat.config.cjs --port 8545
# then run ./skill/run.sh as root (it serves /var/run/dstack.sock).
# Use a fresh fork each time: the stand-in dstack key is deterministic, so on a
# reused fork Ada is already registered and the first check reads differently.
# Runs the code blocks of skills/kudo/SKILL.md verbatim against a fork
# of Robinhood mainnet, with a stand-in dstack.
set -uo pipefail
T=$(cd "$(dirname "$0")" && pwd)
SKILL=$(cd "$T/../../skills/kudo" && pwd)/SKILL.md
command -v cast >/dev/null || { echo "cast is not on PATH (npm i -g @foundry-rs/cast)"; exit 1; }
node "$T/rpc-proxy.mjs" 2>/dev/null & PROXY_PID=$!; sleep 1
# Reads at the fork block itself are refused; move one block past it.
curl -s http://127.0.0.1:8545 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"evm_mine","params":[]}' >/dev/null
export HOME=$T/home RPC_URL=http://127.0.0.1:8546
rm -rf "$HOME" "$T/blocks"; mkdir -p "$HOME" "$T/blocks"
CARTE=0xFB9A9eB13B4Cf30963DCC0A0cbc5598Cc03B2cf3
USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
PASS=0; FAIL=0
ok() { if [ "$1" = "1" ]; then PASS=$((PASS+1)); echo "  ✓ $2"; else FAIL=$((FAIL+1)); echo "  ✗ $2"; fi; }
rpc() { curl -s $RPC_URL -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}"; }
show() { echo "$1" | sed 's/^/    /'; }

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
# A step with its example values replaced, e.g. with_ids meet ID=113 ID=$COV
with() { local f=$1; shift; local s; s=$(cat "$T/blocks/$f.sh"); while [ $# -gt 1 ]; do s=${s//"$1"/"$2"}; shift 2; done; printf '%s' "$s" > "$T/blocks/$f.run.sh"; bash "$T/blocks/$f.run.sh" 2>&1; }
proof_of() { kudo_covenant "$1" | kudo_json 7; }

start_dstack() { node "$T/mock-dstack.mjs" 2>/dev/null & DSTACK_PID=$!; sleep 1; }
stop_dstack()  { kill $DSTACK_PID 2>/dev/null; sleep 0.5; rm -f /var/run/dstack.sock; }
DSTACK_PID=
trap 'kill $PROXY_PID $DSTACK_PID 2>/dev/null; rm -f /var/run/dstack.sock' EXIT
fund() { rpc hardhat_setBalance "[\"$1\",\"0x2386F26FC10000\"]" >/dev/null; }   # 0.01 ETH for gas
newkey() { cast wallet new --json | kudo_json 0.private_key; }
past_cooldown() { rpc evm_increaseTime "[$(( $(cast call $KUDO 'getAskCooldown()(uint256)' --rpc-url $RPC_URL | cut -d' ' -f1) + 1 ))]" >/dev/null; rpc evm_mine "[]" >/dev/null; }

echo "=== Ada: in a Phala TEE (dstack) ==="
start_dstack
unset PRIVATE_KEY AGENT_ID
export AGENT_NAME=Ada
ADA=$(kudo_address); APP=$(kudo_tee_id)
fund $ADA
OUT=$(step balances); show "$OUT"
ok "$(echo "$OUT" | grep -q "^ETH  0.01" && ! echo "$OUT" | grep -qi usdg && echo 1)" "balances step reads ETH only (no USDG needed to promise)"
OUT=$(step startup); show "$OUT"
ADA_ID=$(echo "$OUT" | sed -n 's/^AGENT_ID=//p')
ok "$(echo "$OUT" | grep -q "registered agent" && echo 1)" "startup registered a new identity ($ADA_ID)"
ok "$([ "$(cast call $IDENTITY_REGISTRY 'ownerOf(uint256)(address)' $ADA_ID --rpc-url $RPC_URL)" = "$ADA" ] && echo 1)" "identity owned by Ada's wallet"
ok "$([ "$(cast call $IDENTITY_REGISTRY 'getMetadata(uint256,string)(bytes)' $ADA_ID teeId --rpc-url $RPC_URL | cast to-ascii)" = "$APP" ] && echo 1)" "teeId on chain = dstack app id ($APP)"
ok "$([ "$(cast code $ADA --rpc-url $RPC_URL)" = "0x" ] && echo 1)" "plain transactions: the wallet stays an ordinary account"

OUT=$(step startup); show "$OUT"
ok "$(echo "$OUT" | grep -q "already registered as agent $ADA_ID" && ! echo "$OUT" | grep -q teeId && echo 1)" "second start without AGENT_ID: recovers the id from the logs, nothing rewritten"
OUT=$(AGENT_ID=$ADA_ID RPC_URL=http://127.0.0.1:8547 step startup); show "$OUT"
ok "$(echo "$OUT" | grep -q "already registered as agent $ADA_ID" && echo 1)" "with AGENT_ID set: confirmed by ownerOf, no log scan (works on an RPC that refuses eth_getLogs)"
OUT=$(RPC_URL=http://127.0.0.1:8547 step startup); show "$OUT"
ok "$(echo "$OUT" | grep -q "did not return logs" && ! echo "$OUT" | grep -q "registered agent" && echo 1)" "RPC refuses eth_getLogs: startup stops with a clear message and never registers again"
OUT=$(AGENT_ID=999999999 step startup); show "$OUT"
ok "$(echo "$OUT" | grep -q "already registered as agent $ADA_ID" && echo 1)" "a stale AGENT_ID that this wallet does not own is ignored and the real id recovered"

source "$HOME/kudo.sh"
kudo_send $IDENTITY_REGISTRY "$(cast calldata 'setMetadata(uint256,string,bytes)' $ADA_ID teeId "$(cast from-utf8 stale-app-id)")" >/dev/null 2>&1
OUT=$(AGENT_ID=$ADA_ID step startup); show "$OUT"
ok "$(echo "$OUT" | grep -q "teeId updated" && [ "$(cast call $IDENTITY_REGISTRY 'getMetadata(uint256,string)(bytes)' $ADA_ID teeId --rpc-url $RPC_URL | cast to-ascii)" = "$APP" ] && echo 1)" "stale teeId overwritten at startup"

OUT=$(AGENT_ID=$ADA_ID step mint); show "$OUT"
COV=$(echo "$OUT" | sed -n 's/^minted covenant \([0-9]*\):.*/\1/p')
C=$(kudo_covenant $COV)
ok "$(echo "$C" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s);console.log(c[3]==="INVOICE"&&c[5]==="I'"'"'ll pay 5 USDG within one hour of the link going up."&&String(c[1])===process.argv[1]&&c[2]===0?1:0)})' $ADA_ID)" "minted covenant $COV under agent $ADA_ID (status 0 MINTED), apostrophe intact, id parsed from CovenantMinted"
ok "$([ "$COV" = "$(( $(cast call $KUDO 'getTotalCovenants()(uint256)' --rpc-url $RPC_URL | cut -d' ' -f1) - 1 ))" ] && echo 1)" "the newest covenant is getTotalCovenants() - 1"
OUT=$(AGENT_ID=999999 step mint); show "$OUT"
ok "$(! echo "$OUT" | grep -q "minted covenant" && [ "$COV" = "$(( $(cast call $KUDO 'getTotalCovenants()(uint256)' --rpc-url $RPC_URL | cut -d' ' -f1) - 1 ))" ] && echo 1)" "minting under an id Ada does not own stops at the dry run; nothing is minted"
OUT=$(step read); show "$(echo "$OUT" | head -14)"
ok "$(! echo "$OUT" | grep -q "^#$COV " && echo "$OUT" | grep -q "\b$COV\b" && echo 1)" "read: Ada's covenant is in her own list, not in her open asks"
OUT=$(with keep ID=113 "ID=$COV" "PROOF=0x…" "PROOF=0x$(printf 'ab%.0s' {1..32})")
ok "$(echo "$OUT" | grep -q "nobody has met the ask" && [ -z "$(kudo_covenant $COV | kudo_json 9)" ] && echo 1)" "keep before the ask is met is refused; nothing linked"
stop_dstack

echo "=== Bob: no TEE, PRIVATE_KEY ==="
export PRIVATE_KEY=$(newkey) AGENT_NAME=Bob
BOB=$(cast wallet address --private-key $PRIVATE_KEY)
fund $BOB
OUT=$(step startup); show "$OUT"
BOB_ID=$(echo "$OUT" | sed -n 's/^AGENT_ID=//p')
ok "$(echo "$OUT" | grep -q "registered agent" && [ "$(cast call $IDENTITY_REGISTRY 'getMetadata(uint256,string)(bytes)' $BOB_ID teeId --rpc-url $RPC_URL)" = "0x" ] && echo 1)" "Bob registered ($BOB_ID) with no teeId"
OUT=$(step read)
ok "$(echo "$OUT" | grep -q "^#$COV INVOICE" && echo 1)" "Ada's covenant is in Bob's open asks"
BOB_PROOF="https://ipfs.io/ipfs/bafkreia47kzwlipoeycokourgsngbommecsp5ap7zcpuqdybzknoxepkxm"
OUT=$(with meet ID=113 "ID=$COV" 'PROOF="https://ipfs.io/ipfs/<cid of your work>"' "PROOF=\"$BOB_PROOF\""); show "$OUT"
C=$(kudo_covenant $COV)
ok "$(echo "$C" | grep -q "pay: $BOB" && [ "$(proof_of $COV)" = "$BOB_PROOF" ] && echo 1)" "Bob met the ask with proof and 'pay: $BOB', and the step confirmed the proof is his"
BOB_KEY=$PRIVATE_KEY

echo "=== Carol tries the same ask ==="
export PRIVATE_KEY=$(newkey); CAROL_KEY=$PRIVATE_KEY; CAROL=$(cast wallet address --private-key $PRIVATE_KEY); fund $CAROL
CAROL_PROOF="https://ipfs.io/ipfs/bafkreicarolcarolcarolcarolcarolcarolcarolcarolcarolcarolca"
OUT=$(with meet ID=113 "ID=$COV" 'PROOF="https://ipfs.io/ipfs/<cid of your work>"' "PROOF=\"$CAROL_PROOF\""); show "$OUT"
ok "$(echo "$OUT" | grep -q "already taken" && [ "$(proof_of $COV)" = "$BOB_PROOF" ] && echo 1)" "the meet step refuses an ask someone already met; Bob's proof stays"
past_cooldown
OUT=$(with meet ID=113 "ID=$COV" 'PROOF="https://ipfs.io/ipfs/<cid of your work>"' "PROOF=\"$CAROL_PROOF\"")
ok "$(echo "$OUT" | grep -q "already taken" && [ "$(proof_of $COV)" = "$BOB_PROOF" ] && echo 1)" "after the cooldown the step still refuses: it never replaces a claim"
# What the contract itself allows, recorded for the PR (not a pass/fail of the skill):
SNAP=$(rpc evm_snapshot "[]" | kudo_json result)
cast send $KUDO "$(cast calldata 'setAskSettlementData(uint256,string,string)' $COV "$CAROL_PROOF" "pay: $CAROL")" --private-key $PRIVATE_KEY --rpc-url $RPC_URL >/dev/null 2>&1
echo "    (contract: a direct setAskSettlementData over Bob's claim was $([ "$(proof_of $COV)" = "$CAROL_PROOF" ] && echo ACCEPTED || echo refused))"
rpc evm_revert "[\"$SNAP\"]" >/dev/null
ok "$([ "$(proof_of $COV)" = "$BOB_PROOF" ] && echo 1)" "(fork restored to Bob's claim)"

echo "=== Ada keeps her promise (TEE again) ==="
start_dstack; unset PRIVATE_KEY
rpc hardhat_impersonateAccount "[\"$CARTE\"]" >/dev/null; rpc hardhat_setBalance "[\"$CARTE\",\"0xDE0B6B3A7640000\"]" >/dev/null
rpc eth_sendTransaction "[{\"from\":\"$CARTE\",\"to\":\"$USDG\",\"data\":\"$(cast calldata 'transfer(address,uint256)' $ADA 10000000)\"}]" >/dev/null
BEFORE=$(cast call $USDG 'balanceOf(address)(uint256)' $BOB --rpc-url $RPC_URL | cut -d' ' -f1)
# Step 1 of "Keeping your promise" is Ada's own wallet: 5 USDG = 5000000 base units.
PAY=$(kudo_send $USDG "$(cast calldata 'transfer(address,uint256)' $BOB $(cast parse-units 5 6))" 2>/dev/null)
AFTER=$(cast call $USDG 'balanceOf(address)(uint256)' $BOB --rpc-url $RPC_URL | cut -d' ' -f1)
ok "$([ $((AFTER - BEFORE)) = 5000000 ] && echo 1)" "Ada paid Bob exactly 5 USDG (cast parse-units 5 6 = 5000000) from her own wallet"
OUT=$(with keep ID=113 "ID=$COV" "PROOF=0x…" "PROOF=$PAY"); show "$OUT"
ok "$([ "$(kudo_covenant $COV | kudo_json 9)" = "$PAY" ] && echo 1)" "keep step linked the payment hash as promise proof"
OUT=$(with keep ID=113 "ID=$COV" "PROOF=0x…" "PROOF=0x$(printf 'cd%.0s' {1..32})")
ok "$(echo "$OUT" | grep -q "already has promise proof" && [ "$(kudo_covenant $COV | kudo_json 9)" = "$PAY" ] && echo 1)" "keep again is refused: no second payment, proof unchanged"
stop_dstack
export PRIVATE_KEY=$BOB_KEY
OUT=$(with keep ID=113 "ID=$COV" "PROOF=0x…" "PROOF=0xbeef")
ok "$(echo "$OUT" | grep -q "you did not mint" && echo 1)" "only the minter can run keep"

echo "=== A race: someone claims in the same block, right after the meet step ==="
export PRIVATE_KEY=$BOB_KEY
OUT=$(AGENT_ID=$BOB_ID step mint); RACE=$(echo "$OUT" | sed -n 's/^minted covenant \([0-9]*\):.*/\1/p')
FRANK_KEY=$(newkey); fund $(cast wallet address --private-key $FRANK_KEY)
rpc evm_setAutomine "[false]" >/dev/null
( PRIVATE_KEY=$FRANK_KEY with meet ID=113 "ID=$RACE" 'PROOF="https://ipfs.io/ipfs/<cid of your work>"' 'PROOF="https://ipfs.io/ipfs/frank"' > "$T/race.out" ) &
MEET_PID=$!
for _ in $(seq 1 60); do [ "$(rpc eth_getBlockByNumber '["pending",false]' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).result.transactions.length))')" -ge 1 ] && break; sleep 0.5; done
# The rival pays no tip, so the block orders it after Frank's claim and its proof is the one left.
cast send $KUDO "$(cast calldata 'setAskSettlementData(uint256,string,string)' $RACE "https://ipfs.io/ipfs/carol" "pay: $CAROL")" --private-key $CAROL_KEY --priority-gas-price 0 --rpc-url $RPC_URL --async >/dev/null 2>&1
rpc evm_mine "[]" >/dev/null; rpc evm_setAutomine "[true]" >/dev/null
wait $MEET_PID; OUT=$(cat "$T/race.out"); show "$OUT"
ok "$(echo "$OUT" | grep -q "lost the race" && [ "$(proof_of $RACE)" = "https://ipfs.io/ipfs/carol" ] && echo 1)" "the meet step notices a claim that landed after its own and reports it lost the race"

echo "=== Erin receives Bob's identity by transfer ==="
ERIN_KEY=$(newkey); ERIN=$(cast wallet address --private-key $ERIN_KEY); fund $ERIN
kudo_send $IDENTITY_REGISTRY "$(cast calldata 'transferFrom(address,address,uint256)' $BOB $ERIN $BOB_ID)" >/dev/null 2>&1
OUT=$(PRIVATE_KEY=$ERIN_KEY AGENT_NAME=Erin step startup); show "$OUT"
ok "$(echo "$OUT" | grep -q "already registered as agent $BOB_ID" && ! echo "$OUT" | grep -q "registered agent [0-9]* in" && echo 1)" "a transferred identity is found through its Transfer log; no second registration"

echo "=== No ETH: writes fail cleanly ==="
export PRIVATE_KEY=$(newkey) AGENT_NAME=Dora
OUT=$(step startup)
ok "$(echo "$OUT" | grep -qi "funds" && ! echo "$OUT" | grep -q "registered agent" && echo 1)" "an unfunded wallet stops at startup with a gas error"

echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
