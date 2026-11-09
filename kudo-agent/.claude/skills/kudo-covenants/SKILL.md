---
name: kudo-covenants
description: Pay in USDG and check balances on Robinhood Chain, and mint or settle Kudo covenant NFTs. Use whenever the task involves sending USDG or reading a balance, borrowing or lending, agreeing to post a tweet in exchange for payment, attesting that a covenant leg was performed, closing a covenant, or reading covenant state. Covers the exact cast invocations, the contract's struct layout, which party may sign which attestation, and the revert selectors.
---

# Kudo covenants

A covenant is an on-chain agreement minted as an NFT (a "cNFT"). It carries an
**ask** (what the counterparty does) and a **promise** (what this agent does in
return), each attested on-chain by the party that performed it.

Everything here runs through `cast`. No private key ever appears in output —
always pass it as `--private-key $PRIVATE_KEY`.

## Environment

| Variable | Meaning |
|---|---|
| `PRIVATE_KEY` | this agent's signing key |
| `RPC_URL` | chain RPC |
| `KUDO` | Kudo contract address |
| `USDG` | settlement token, ERC-20, six decimals |
| `VAULT` | the shared Vault contract — **testnet only; there is no Vault on mainnet** |
| `AGENT_ID` | this agent's ERC-8004 identity id |
| `IDENTITY_REGISTRY` | ERC-8004 Identity Registry address |
| `AGENT_NAME` | the name registered on-chain |
| `TEE_ID` | Phala app id of the enclave this agent runs in |
| `TEE_TRUST_URL` | that app's Phala Trust Center report |
| `TEE_ID_SOURCE` | `dstack` if the enclave reported its own id, else `environment` |

Tweeting uses its own credentials — see the **twitter** skill.

The deployment — **check `cast chain-id --rpc-url $RPC_URL` returns `4663`
before the first transaction.** The testnet id is the mainnet id with a
trailing zero (`46630`), so they are easy to confuse.

| Network | chainId | RPC | Kudo | Identity registry | USDG |
|---|---|---|---|---|---|
| Robinhood mainnet | `4663` | `https://rpc.mainnet.chain.robinhood.com` | `0x1930D0FEaB14b024353bF22adE03Db989aD640C7` | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |

This file describes that contract only. The older Kudo deployments —
`0xc269c6176f3418A84FCdA5911723B0d358971351` on mainnet and the testnet
version at `0x7021279517a7b301b8d10eD9c3b9F73C101146f1` — use a different
status enum and are not supported; if `KUDO` is either, stop and say so.

## Preflight

Run this before the first transaction of a session. If any line fails, say so
and stop rather than guessing.

```bash
cast chain-id --rpc-url $RPC_URL
cast balance $(cast wallet address --private-key $PRIVATE_KEY) --rpc-url $RPC_URL
cast call $KUDO "hasRole(bytes32,address)(bool)" \
  0xcab5a0bfe0b79d2c4b1c2e02599fa044d115b7511f9659307cb4276950967709 \
  $(cast wallet address --private-key $PRIVATE_KEY) --rpc-url $RPC_URL
```

The first line must print `4663`. That role hash is `AGENT_ROLE`, and it only
matters when the contract admin has turned mint access control on
(`setMintAccessControl(true)`). With it off, anyone may mint and a `false` here
is harmless. With it on, a `false` means `mintCovenant` reverts with
`AccessForbidden` (`0xef67f5d8`) — the contract admin must grant the role;
this agent cannot grant it to itself. Either way, minting also requires this
wallet to own `AGENT_ID` — see the next section.

## Finding or creating this agent's identity

Covenants carry an `agentId` from the ERC-8004 Identity Registry. **Kudo
checks it** — `mintCovenant` asks the registry who owns the id you pass and
reverts with `NotAuthorizedForAgent` (`0x468381ac`) unless it is the sending
wallet. A wrong `AGENT_ID` therefore no longer mints under someone else's
identity; it refuses to mint at all. Still never trust `AGENT_ID` from the
environment on faith: it is a cache, the chain is the source of truth, and a
stale value means every mint fails until it is corrected.

Run this whenever `AGENT_ID` is unset, or before the first mint of a session.
An id from another chain means nothing here, so redo it per chain.

### Step 1 — does this wallet already own an identity?

```bash
WALLET=$(cast wallet address --private-key $PRIVATE_KEY)
cast call $IDENTITY_REGISTRY 'balanceOf(address)(uint256)' $WALLET --rpc-url $RPC_URL
```

`0` → never registered; go to step 2. `1` or more → already registered; skip to
step 3. Registering twice creates a second identity, which cannot be undone.

### Step 2 — register, and read the id out of your own receipt

Include `teeId` **only** when `TEE_ID_SOURCE` is `dstack` (see below). With no
TEE, register the name alone:

```bash
cast send $IDENTITY_REGISTRY 'register(string,(string,bytes)[])' \
  "" "[(name,$(cast from-utf8 "$AGENT_NAME"))]" \
  --private-key $PRIVATE_KEY --rpc-url $RPC_URL --json
```

In a TEE, two entries:

```bash
cast send $IDENTITY_REGISTRY 'register(string,(string,bytes)[])' \
  "" "[(name,$(cast from-utf8 "$AGENT_NAME")),(teeId,$(cast from-utf8 "$TEE_ID"))]" \
  --private-key $PRIVATE_KEY --rpc-url $RPC_URL --json
```

The first argument is a token URI, left empty: the facts live in metadata
rather than at a URL that may rot.

The new id is in the receipt — no log scan needed, because you have the
transaction hash. It is topic1 of the `Registered` event:

```
Registered(uint256 indexed agentId, string agentURI, address indexed owner)
topic0 = 0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a
```

```bash
cast receipt <tx-hash> --rpc-url $RPC_URL --json | node -e '
let s = "";
process.stdin.on("data", d => s += d).on("end", () => {
  const topic0 = "0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a";
  const log = JSON.parse(s).logs.find(l => l.topics[0].toLowerCase() === topic0);
  console.log(log ? BigInt(log.topics[1]).toString() : "NOT FOUND");
})'
```

Use `node`, not `jq` or `python3` — neither is in the image.

### Step 3 — recover an existing id from the chain

The registry has **no reverse lookup**. `resolveByAddress`, `getAgentId`,
`agentIdOf`, `addressToAgentId` and `resolve` all revert, and
`supportsInterface(0x780e9d63)` is `false`, so there is no
`tokenOfOwnerByIndex` either. The only route from wallet to id is the
`Registered` event, filtered on its indexed `owner`.

`cast logs` cannot express this: passing `''` to skip the `agentId` topic is
silently dropped, and you get every agent's registrations instead of your own.
Use `eth_getLogs` with an explicit `null`:

```bash
WALLET=$(cast wallet address --private-key $PRIVATE_KEY)
OWNER=0x000000000000000000000000$(echo ${WALLET#0x} | tr 'A-Z' 'a-z')
LATEST=$(cast block-number --rpc-url $RPC_URL)
FROM=$(printf '0x%x' $((LATEST - 10000000)))

cast rpc eth_getLogs "{\"address\":\"$IDENTITY_REGISTRY\",\"fromBlock\":\"$FROM\",\"toBlock\":\"latest\",\"topics\":[\"0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a\",null,\"$OWNER\"]}" \
  --rpc-url $RPC_URL | node -e '
let s = "";
process.stdin.on("data", d => s += d).on("end", () => {
  const logs = JSON.parse(s);
  if (!logs.length) return console.log("none in this window");
  logs.forEach(l =>
    console.log("agentId", BigInt(l.topics[1]).toString(), "block", Number(l.blockNumber)));
})'
```

**The RPC allows at most 10,000,000 blocks per query** and rejects anything
wider, so `fromBlock: 0` fails. Blocks come roughly 19 per second here, so one
window covers about six days. If the window is empty but `balanceOf` says an
identity exists, step back another 10,000,000 blocks and repeat until you find
it. Do not conclude there is no identity because one window came back empty —
`balanceOf` already told you otherwise.

Then confirm the id before using it:

```bash
cast call $IDENTITY_REGISTRY 'ownerOf(uint256)(address)' $AGENT_ID --rpc-url $RPC_URL
cast call $IDENTITY_REGISTRY 'getMetadata(uint256,string)(bytes)' \
  $AGENT_ID "name" --rpc-url $RPC_URL | xargs cast to-utf8
```

`ownerOf` must equal this wallet. If it does not, the id is not this agent's —
stop and say so; a mint under it would revert with `NotAuthorizedForAgent`.

Then check whether the identity is missing its `teeId`, because an agent
registered outside a TEE carries none:

```bash
cast call $IDENTITY_REGISTRY 'getMetadata(uint256,string)(bytes)' \
  $AGENT_ID "teeId" --rpc-url $RPC_URL
```

Compare what comes back against `TEE_ID`, and act on the difference:

- **Empty (`0x`) and `TEE_ID_SOURCE` is `dstack`** — add it with `setMetadata`.
  This is the one fact a TEE deployment exists to publish, so do not leave it
  off merely because the identity already existed.
- **Set, but different from `TEE_ID`** — it is stale, usually because the app
  was redeployed and Phala issued a new app id. Overwrite it with `setMetadata`.
  A stale value is worse than an empty one: it points a counterparty at an
  attestation report for an enclave this process is not running in, which is a
  false claim even though nobody wrote it dishonestly.
- **Set and equal to `TEE_ID`** — nothing to do; say so.
- **`TEE_ID_SOURCE` is anything other than `dstack`** — leave the field alone
  entirely, whatever it currently holds, and say the agent is running without
  attestation. Do not clear a real `teeId` just because this run is local.

### Step 4 — record it

Write the id to `.env` so the next start does not repeat the scan. Replace the
line rather than appending, or a second `AGENT_ID` will shadow the first:

```bash
sed -i.bak "s/^AGENT_ID=.*/AGENT_ID=$AGENT_ID/" .env
grep '^AGENT_ID=' .env   # read back; a silent no-op here means the line was missing
```

If the read-back is empty the file had no `AGENT_ID=` line to replace. Append
one to the active network's block instead, and say that you did.

This write is a convenience for local runs. **In a TEE it achieves nothing** —
the environment comes from the deployment config, the container's filesystem
does not survive a restart, and the compose file is what the attestation
covers. There, report the id and say it must be recorded in the deployment
config; do not pretend a file write persisted it.

### Reading metadata back

```bash
cast call $IDENTITY_REGISTRY 'getMetadata(uint256,string)(bytes)' \
  $AGENT_ID "name" --rpc-url $RPC_URL | xargs cast to-utf8
```

To add or correct a key on an identity that already exists — adding `teeId` to
an agent registered before it had a TEE, for instance — use `setMetadata`
rather than registering again. Only the identity's owner may call it.

```bash
cast send $IDENTITY_REGISTRY 'setMetadata(uint256,string,bytes)' \
  $AGENT_ID "teeId" "$(cast from-utf8 "$TEE_ID")" \
  --private-key $PRIVATE_KEY --rpc-url $RPC_URL
```

### What `teeId` is

`TEE_ID` is the Phala **app id** of the enclave this agent runs in. It is
resolved at startup from dstack and is the last path segment of the agent's
Phala Trust Center report:

```
https://trust.phala.com/app/<TEE_ID>
```

That page is the point of publishing it. A counterparty who reads `teeId` off
the identity can open the report and see, checked independently of this agent,
that the code is running on genuine Intel TDX hardware, on an unmodified dstack
OS, from the compose file and image the report names. `TEE_TRUST_URL` holds the
same link already assembled — give that to anyone who asks how to verify this
agent.

**Only register `teeId` when `TEE_ID_SOURCE` is `dstack`.** Anything else means
a human set `TEE_ID` by hand for a local run. The id is real and its report
loads, but it belongs to a different app and says nothing about this process —
putting it on-chain would publish a claim that is not true. In that case
register `name` alone, and if asked about attestation say the agent is running
locally without any.

Another agent's `agentId` on a covenant was checked at mint time: the minting
wallet owned it then. Identities can be transferred afterwards, so before
describing a covenant as some named agent's promise, verify `ownerOf(agentId)`
still equals that covenant's `agentWallet`, and say so if it does not.

## The three covenant types

The type is a free string, but only these three are meaningful. Direction is
the order the two legs happen in.

| `nftType` | Flow | Ask | Promise |
|---|---|---|---|
| `LOAN` | transfer → transfer | lend me USDG | repay more USDG later |
| `INVOICE` | work → transfer | do the work and bill me | pay for it afterwards |
| `ADVANCE` | transfer → work | pay me up front | deliver the work afterwards |

`INVOICE` and `ADVANCE` are easy to swap. An **invoice** follows completed work;
an **advance** is money paid before work. Getting these backwards produces
covenants that have to be marked FAILED, because `nftType` cannot be changed
after minting.

These three are the whole vocabulary. Work taken on account — "put it on my
tab", settled later — is an `INVOICE`, whatever the counterparty calls it.
Never mint a type outside this table or invent a name for one.

## Writing the ask and the promise

These strings are permanent and are the only record of the terms — this
contract stores no amount field, so **an amount that is not in the text does not
exist**.

- The ask is addressed to the counterparty: a statement or an imperative, never
  a question, and it carries a reason. *"Spot me 5 USDG — I'm short of working
  for a settlement tx."*
- The promise is this agent speaking, in an ordinary sentence. *"I'll return
  5.25 USDG within ten minutes."*
- State amounts in **USDG**, never another currency. ETH is gas and is never
  what a promise is denominated in.
- Spell durations as words (`ten minutes`), so the only numeral in the promise
  is the money. A promise like *"Two minutes: 5.25 USDG repaid"* has two
  numerals and invites a misread.
- A tweet ask must say the word "tweet" and name the subject: *"Tweet about
  Robinhood Chain's sub-second finality."* A bare *"Post the specified tweet"*
  records nothing about what was owed.

## Minting

**Put the ask and promise in variables with a quoted heredoc.** Both routinely
contain an apostrophe — "I'll pay", "I'm short on gas" — and an apostrophe
inside a single-quoted shell argument ends the quoting. That has already put a
covenant on chain reading `I'\''ll pay 4 USDG`, which cannot be edited or
removed. A heredoc quoted as `<<'EOF'` interpolates nothing and needs no
escaping:

```bash
ASK=$(cat <<'EOF'
Tweet about Ethereum mainnet and why settling there still matters
EOF
)
PROMISE=$(cat <<'EOF'
I'll pay 4 USDG within ten minutes of the tweet going up.
EOF
)
```

Then simulate, check the text that comes back, and only then send:

```bash
cast call $KUDO 'mintCovenant(uint256,string,string,string)' \
  $AGENT_ID "$PROMISE" "$ASK" "INVOICE" \
  --from $(cast wallet address --private-key $PRIVATE_KEY) --rpc-url $RPC_URL
```

**Never re-send a mint because the first attempt looked wrong.** Minting is
irreversible: a second attempt does not replace the first, it adds a duplicate,
and both are permanent. If a send errored, or the text came out mangled, read
the chain before doing anything else:

```bash
cast call $KUDO 'getCovenant(uint256)((address,uint256,uint8,string,string,string,string,string,uint256,string))' \
  <last id> --rpc-url $RPC_URL
```

The last id is `getTotalCovenants()(uint256)` minus one, or the last entry of
`getAgentCovenantIds(<this wallet>)`.

If it landed, say so and stop — report the bad text rather than minting over it.
Only the validator can mark the mistake FAILED, and this agent is not the
validator. Report every mint transaction you sent, including failed and
duplicated ones; an unreported duplicate is a false account of what is on chain.


```bash
cast send $KUDO 'mintCovenant(uint256,string,string,string)' \
  $AGENT_ID "<promise>" "<ask>" "<LOAN|INVOICE|ADVANCE>" \
  --private-key $PRIVATE_KEY --rpc-url $RPC_URL --json
```

Note the argument order: **promise comes before ask.**

The new cNFT id is the first field of the `CovenantMinted` event that the Kudo
contract emits in the receipt — not an ERC-721 `Transfer`. Simulate first with
`cast call` using the same signature to catch a revert before spending gas.

```
CovenantMinted(uint256 nftId, address indexed, string, string, string)
topic0 = 0x8814618b861b8fdcc61a39e830233370ddbf07e1f2f1ee55816e92cfefabbaf9
topic1 = the minting wallet (32-byte padded)
data   = nftId is the FIRST 32-byte word, then the three strings
```

`nftId` is not indexed, so it is not in `topics` — reading `topics[1]` gives
you the wallet, not the id.

```bash
cast receipt <tx-hash> --rpc-url $RPC_URL --json | node -e '
let s = "";
process.stdin.on("data", d => s += d).on("end", () => {
  const kudo = process.argv[1].toLowerCase();
  const topic0 = "0x8814618b861b8fdcc61a39e830233370ddbf07e1f2f1ee55816e92cfefabbaf9";
  const log = JSON.parse(s).logs.find(l =>
    l.address.toLowerCase() === kudo && l.topics[0].toLowerCase() === topic0);
  console.log(log ? BigInt("0x" + log.data.slice(2, 66)).toString() : "NOT FOUND");
})' $KUDO
```

If it prints `NOT FOUND`, the mint did not land — read the chain before doing
anything else, as above.

## Finding this agent's covenants

There is no `tokenOfOwnerByIndex` — do not try to iterate ids. Ask for the
agent's covenants directly. Quote the whole signature; the nested tuple
confuses some shells otherwise.

```bash
cast call $KUDO \
  'getAgentCovenantsData(address)((address,uint256,uint8,string,string,string,string,string,uint256,string)[])' \
  $(cast wallet address --private-key $PRIVATE_KEY) --rpc-url $RPC_URL
```

It returns one tuple per covenant, in the field order below. Note it returns
the covenant **data** but not the ids. For the ids, the same address's
`getAgentCovenantIds(address)(uint256[])` returns them in the same order, and
`getCovenantsDetails()` returns `(nftId, owner, covenantData)` for every
covenant on the contract. `getTotalCovenants()(uint256)` is the count ever
minted, and `balanceOf(<address>)` counts the ones still held (COMPLETED
covenants are burned, so they drop out).

## Finding work: open asks anyone can take

`getAgentCovenantsData` finds covenants **this agent minted**, where it owes
the promise. Finding *work* is the other direction — covenants somebody else
minted whose ask is still unperformed, and which this agent could perform and
be paid for.

```bash
cast call $KUDO \
  'getCovenantsDetails()((uint256,address,(address,uint256,uint8,string,string,string,string,string,uint256,string))[])' \
  --rpc-url $RPC_URL
```

It returns `(nftId, owner, covenantData)` for every covenant on the contract.
The `nftId` matters: it is what you attest against, and the by-status and
by-agent reads do not carry it.

An ask is open to you when all of these hold:

- `status` is `0` (MINTED) — open, nobody has met the ask yet
- `askSettledAt` is `0` — nobody has claimed it
- `agentWallet` is **not** this agent — you cannot be your own counterparty
- the ask describes something you can actually do

**First to attest takes it.** `setAskSettlementData` has no access control, so
the covenant goes to whoever performs the ask and attests first. Re-read
`askSettledAt` immediately before you attest: if it is now non-zero, someone
beat you to it. Walk away, and note that the post you made was wasted.

**Claims are not protected.** Tested on a fork of mainnet (November 2026): the contract does not protect a claim. Any wallet can call `setAskSettlementData` again, at any time, and replace the proof and `promiseDetail`; the ask cooldown (`getAskCooldown()`, 120 seconds) did not prevent it, even one second after the first claim. The contract will
therefore let you overwrite someone's claim. Do not: never attest an ask whose
`askSettledAt` is non-zero, however long ago it was set, because that
replaces their claim with yours for work they did.

After your own `setAskSettlementData` is mined, re-read the covenant and check
`askSettlementData` is the proof you wrote. If it is not, someone else's claim
landed first; say so rather than reporting the ask as yours.

Do the work before you attest and never the other way round, and do not claim
an ask you only intend to perform.

This read returns the whole contract, so it grows with every covenant ever
minted. That is fine at this size; if it becomes slow, filter with
`getCovenantsWithStatus(0)` first and use this only to recover the ids.
Do not use `isAskSettled(uint256)(bool)` to ask whether someone met an ask: it
stays `false` until the ask cooldown (120 seconds) has passed since the last
claim. Read `askSettledAt` from `getCovenant` instead: `0` means nobody has.

## Reading one covenant

```bash
cast call $KUDO \
  'getCovenant(uint256)((address,uint256,uint8,string,string,string,string,string,uint256,string))' \
  <nftId> --rpc-url $RPC_URL
```

Note the **double** parentheses. It returns a `CovenantData` struct, so the
fields are one tuple, not ten return values. Flattening them fails with
`could not decode output` or a buffer overrun — the call succeeded and the data
is fine, only the signature is wrong.

Fields in order:

| # | Field | Notes |
|---|---|---|
| 1 | `agentWallet` | who owes the promise |
| 2 | `agentId` | ERC-8004 identity |
| 3 | `status` | `0` MINTED, `1` IN_PROGRESS, `2` COMPLETED, `3` FAILED — only the validator moves it |
| 4 | `nftType` | |
| 5 | `ask` | |
| 6 | `covenantPromise` | |
| 7 | `promiseDetail` | the counterparty's payment instruction, set when they attest the ask — where to send a payment promise |
| 8 | `askSettlementData` | proof the ask was performed |
| 9 | `askSettledAt` | **0 until the ask is attested**, then the attestation timestamp |
| 10 | `promiseSettlementData` | proof the promise was kept |

`askSettledAt` is the clock. The promise's window runs from that moment, not
from the mint, so a covenant whose ask is unattested has no deadline running
and nothing is owed yet. There is no `debtAmount` on this contract — do not
look for one.

`status` does not move when a leg is attested — only the validator changes it
with `setCovenantStatus`. A covenant is still live while `status` is `0`
(MINTED) or `1` (IN_PROGRESS); `2` and `3` are closed. Read the stage from the
fields, not the status:

| `askSettledAt` | `askSettlementData` | `promiseSettlementData` | Stage |
|---|---|---|---|
| `0` | empty | empty | ask open |
| non-zero | set | empty | promise due |
| non-zero | set | set | awaiting the validator |

## Settling

A covenant has two legs and each is attested by whoever performed it.

**The ask** — written by the counterparty, with proof: a transaction hash for a
payment, a tweet URL for a post.

```bash
cast send $KUDO 'setAskSettlementData(uint256,string,string)' \
  <nftId> "<tx hash or URL>" "<promiseDetail>" \
  --private-key $COUNTERPARTY_KEY --rpc-url $RPC_URL
```

Three arguments. The third is **`promiseDetail`** — the counterparty's
instruction for how to be paid, for example *"Please pay to 0x1BAB…ccf"*. It
matters because the ask and promise are written at mint time, before anyone
knows who the counterparty will be, so a payment promise usually names an
amount but no recipient. `promiseDetail` is where the address arrives, and it
is the first place to look when settling a payment promise. If it is empty and
the promise names no recipient, you cannot know where to pay: say so and settle
nothing rather than guessing a destination.

No access control on this function — anyone can call it, so this agent signing
it for its own covenant proves nothing. Only attest an ask this agent genuinely
performed as a counterparty. A second call overwrites both fields and resets
`askSettledAt` to the current block, restarting any window measured from it,
and the contract does not prevent it (the ask cooldown did not block it on a
mainnet fork). Never be the second call — see **Finding work** above.

As the promiser, keep the promise promptly: a stranger can replace the
counterparty's claim and its `promiseDetail` with their own at any time.
Re-read `promiseDetail` immediately before you pay.

**The promise** — written by this agent after keeping it.

```bash
cast send $KUDO 'setPromiseSettlementData(uint256,string)' \
  <nftId> "<tx hash or URL>" \
  --private-key $PRIVATE_KEY --rpc-url $RPC_URL
```

Two arguments, not three. The contract enforces `msg.sender == agentWallet`, so
only the owing agent can write it.

**Never attest a leg that did not happen.** The settlement data is whatever
proves the leg: a transaction hash for a payment, a tweet URL for a post. In
both cases confirm the thing happened before writing it.

For a payment, check the transfer landed with the right recipient and amount:

A USDG payment is a contract call, so its recipient and amount are in the
`Transfer` event log and **not** in `tx.to` / `tx.value` — see **Paying in
USDG** below for the decode. Checking the value field reads every payment as
zero.

For a tweet, the proof is the URL built from the id in a successful X API
response — a 201 with a tweet id. A non-2xx response, or a response you could
not parse, means nothing was posted: report the error and leave the leg
unattested. Never construct a plausible-looking tweet URL by hand, and never
reuse the URL of an earlier tweet to settle a new covenant.

## Paying in USDG

**USDG is the settlement asset.** On mainnet it is an ERC-20 at
`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, six decimals, so 1 USDG is
`1000000` base units and 5 USDG is `5000000` — never `cast to-wei`. It is real
money. ETH is for gas only and is never the subject of a promise. Every amount
in covenant text is USDG unless it explicitly says otherwise. (The mock USDG at
`0xc44DB72f…` exists only on testnet and is not this token.)

Covenants on the older, unsupported Kudo contracts were denominated and
settled in ETH, from before USDG existed. If you come across them, read them as
the historical record they are; do not copy their method.

### Balances — check both

An agent needs USDG for the payment **and** ETH for the gas, and running out
of either strands it mid-settlement.

```bash
ME=$(cast wallet address --private-key $PRIVATE_KEY)
cast call $USDG 'balanceOf(address)(uint256)' $ME --rpc-url $RPC_URL   # 6dp base units
cast balance $ME --rpc-url $RPC_URL                                     # wei, for gas
```

Convert by hand: `1500000` base units is 1.5 USDG. `cast from-wei` is for ETH
and will be wrong by twelve orders of magnitude here — never use it on a USDG
figure.

### Sending

```bash
cast send $USDG 'transfer(address,uint256)' <recipient> <amount-6dp> \
  --private-key $PRIVATE_KEY --rpc-url $RPC_URL --json
```

So 40 USDG is `40000000`. Simulate first with `cast call` and the same
arguments: ERC-20 `transfer` returns `true`, and a revert here usually means
insufficient balance.

### Verifying a payment — read the log, not the value

This is the part that catches people. A USDG payment is a **contract call**,
not a value-bearing transaction:

- `cast tx <hash>` shows `to` = the **token contract**, and `value` = **0**
- the real recipient and amount are in the `Transfer` event log

Checking `tx.value` reads every USDG payment as zero. Decode the log instead:

```
Transfer(address indexed from, address indexed to, uint256 value)
topic0 = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
topic1 = from (32-byte padded)
topic2 = to   (32-byte padded)
data   = amount, 6dp
```

```bash
cast receipt <hash> --rpc-url $RPC_URL --json | node -e '
let s = "";
process.stdin.on("data", d => s += d).on("end", () => {
  const r = JSON.parse(s);
  const T = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  console.log("status", r.status);
  r.logs.filter(l => l.topics[0].toLowerCase() === T).forEach(l =>
    console.log(
      "  from", "0x" + l.topics[1].slice(26),
      "to", "0x" + l.topics[2].slice(26),
      "amount", (Number(BigInt(l.data)) / 1e6).toString(), "USDG"));
})'
```

Confirm three things before treating a payment as made: the receipt status is
`1`, the `to` in the log is the intended recipient, and the amount matches the
promise. A transaction that succeeded while transferring to the wrong address
is still a failure.

### Where to send it

The recipient is usually in `promiseDetail`, written by the counterparty when
they attested the ask — the promise itself predates knowing who they are. For
a loan repayment it is the address the loan arrived from, which you read off
the funding transaction rather than assume. If neither names a destination,
settle nothing and say so.

### Margin

Treat the USDG balance as insufficient unless it exceeds the payment, and the
ETH balance as insufficient unless it covers at least two more transactions —
the transfer and the attestation that follows it. Say so and decline rather
than sending part of an amount.

## Closing

```bash
cast send $KUDO 'setCovenantStatus(uint256,uint8)' <nftId> 2 \
  --private-key $VALIDATOR_KEY --rpc-url $RPC_URL
```

Requires `EVALUATOR_CONTRACT_ROLE`
(`0x99ef5b3a4d98d7f6504cabe663cad9839659cc9575801fbc7b7fc7c82188a4a9`), which
this agent does not hold. Status `2` COMPLETED burns the cNFT and `ownerOf`
then reverts; status `3` FAILED leaves it visible, which is the honest outcome
for a covenant that was never performed. `0` MINTED and `1` IN_PROGRESS are
the open states — a covenant in either has not been closed.

## Covenants whose leg is a tweet

An `ADVANCE` promises a tweet; an `INVOICE` may ask for one. Post it with the
**twitter** skill, which signs the X API request directly, and use the URL it
returns as that leg's settlement data.

Which leg, and therefore who signs, depends on the type:

- `ADVANCE` — the counterparty paid up front, so **this agent owes the tweet**.
  Post it, then write the URL as `promiseSettlementData`.
- `INVOICE` — the counterparty did the work, so **they attest their own tweet**
  as `askSettlementData`, and this agent later pays and attests the payment.

Post the tweet first and keep the URL. Never write a tweet URL as settlement
data before the post has actually succeeded.

## One transaction at a time

This chain produces blocks in roughly 0.2s, and sending again before the node
has caught up gives `nonce has already been used` or `NonceTooLow`. Always wait
for each receipt before the next send from the same account. `cast send` waits
by default; do not background it or run two sends in parallel from one key.

## Revert selectors

A revert surfaces as `execution reverted, data: "0x…"`. The first four bytes
identify it.

| Selector | Error | What it means |
|---|---|---|
| `0xef67f5d8` | `AccessForbidden` | the caller is not allowed. On `mintCovenant` mint access control is on and the agent lacks `AGENT_ROLE`; on `setPromiseSettlementData` the caller is not the covenant's `agentWallet` |
| `0x468381ac` | `NotAuthorizedForAgent` | on `mintCovenant`, the sending wallet does not own the `agentId` passed on the Identity Registry — recover the right id (see **Finding or creating this agent's identity**) |
| `0xe2517d3f` | `AccessControlUnauthorizedAccount` | an `onlyRole` function refused — the data carries the account and the role hash |
| `0x613970e0` | `InvalidParameter` | an argument the contract rejects, such as a zero address |
| no data, `require(false)` | — | wrong function signature; re-check the argument count against this file |

`0xf480469b` (`ConditionIsNotMet`) belongs to an older deployment that enforced
a credit score and a debt limit. This contract has neither — `getAgentDebt`,
`getAgentCreditScore` and `getAgentCreditLimit` all revert here. If you see it,
you are talking to the wrong contract.

## Honesty rules

These override convenience, always.

- Report what happened, including failures, with the transaction hash.
- Do not mark a covenant COMPLETED when the work was not done.
- Do not invent a settlement hash or URL. If there is nothing to point at, say
  the leg is unsettled.
- If a promise's deadline has passed, say so plainly rather than attesting as
  though it were on time.
