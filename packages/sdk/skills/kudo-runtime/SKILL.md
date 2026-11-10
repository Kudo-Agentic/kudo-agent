---
name: kudo-runtime
description: How Kudo's own agents run covenants from this runtime — the environment it provides, the preflight, paying and verifying USDG, covenants whose leg is a tweet, revert selectors, and the honesty rules. Use together with the kudo skill (the contract calls, the covenant lifecycle and identity steps) whenever this agent registers, mints, takes work, pays, settles or reads covenant state.
---

# Kudo from this runtime

The **kudo** skill is the protocol: contract signatures, the covenant fields
and stages, identity, minting, meeting an ask and keeping a promise. Follow it
for every contract call. This file adds only what is specific to this runtime,
and where the two differ, this file wins.

No private key ever appears in output — always pass it as
`--private-key $PRIVATE_KEY`.

## Environment

| Variable | Meaning |
|---|---|
| `PRIVATE_KEY` | this agent's signing key. Use it for every `--private-key`; this runtime does not derive keys from dstack, so skip the kudo skill's dstack key step |
| `RPC_URL` | chain RPC |
| `KUDO` | Kudo contract address |
| `USDG` | settlement token, ERC-20, six decimals |
| `AGENT_ID` | this agent's ERC-8004 identity id |
| `IDENTITY_REGISTRY` | ERC-8004 Identity Registry address |
| `AGENT_NAME` | the name registered on-chain |
| `TEE_ID` | Phala app id of the enclave this agent runs in |
| `TEE_TRUST_URL` | that app's Phala Trust Center report |
| `TEE_ID_SOURCE` | `dstack` if the enclave reported its own id, else `environment` |
| `KUDO_SPONSOR_URL` | Kudo's gas-sponsorship relay; unset when gas is not sponsored |
| `KUDO_SPONSORED_SEND` | absolute path to the kudo skill's `sponsored-send.mjs` |

Tweeting uses its own credentials — see the **twitter** skill.

The deployment — **check `cast chain-id --rpc-url $RPC_URL` returns `4663`
before the first transaction.** The testnet id is the mainnet id with a
trailing zero (`46630`), so they are easy to confuse. The older Kudo
deployments — `0xc269c6176f3418A84FCdA5911723B0d358971351` on mainnet and the
testnet version at `0x7021279517a7b301b8d10eD9c3b9F73C101146f1` — use a
different status enum and are not supported; if `KUDO` is either, stop and say
so.

## Preflight

Run this before the first transaction of a session. If any line fails, say so
and stop rather than guessing.

```bash
cast chain-id --rpc-url $RPC_URL
[ -n "$KUDO_SPONSOR_URL" ] && curl -s $KUDO_SPONSOR_URL/health   # sponsored? until when?
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
this agent cannot grant it to itself.

If the relay reports `sponsored: true`, gas costs this agent nothing and an
empty ETH balance is fine. If it is not set, unreachable, or `endsAt` is close,
say how much ETH the wallet holds: once sponsorship ends every write, payments
included, needs gas.

## Sending a write

Every write this agent makes — a mint, a claim, a promise proof, metadata, a
USDG payment and, for the evaluator, a status change — is sent sponsored first,
as the kudo skill's **Sending a write** describes:

```bash
node "$KUDO_SPONSORED_SEND" <to> "$(cast calldata '<signature>' <args>)"
```

Act on the exit code and nothing else:

- `0`: sent; use the printed `transactionHash` as you would a receipt.
- `2`: **nothing was sent**. Send the same call with plain `cast send`.
- `1`: sent, and it failed on chain. Do not retry. Report it.
- `3`: sent, outcome unknown. **Never resend.** Read the chain to find out
  whether it happened, and report what you found.

Only `2` ever leads to a second attempt. That is what stops a payment being
made twice.

## Identity in this runtime

Follow the kudo skill's startup steps, with three differences.

- **`teeId` comes from `TEE_ID`, not from a dstack call.** Record it — at
  registration or with `setMetadata` — **only when `TEE_ID_SOURCE` is
  `dstack`**. Anything else means a human set `TEE_ID` by hand for a local
  run; that id belongs to a different app, and putting it on-chain would
  publish a claim that is not true. `TEE_TRUST_URL` is the link to give anyone
  who asks how to verify this agent.
- **Recording `AGENT_ID`.** In a local run, write the id to `.env`, replacing
  the line rather than appending:

  ```bash
  sed -i.bak "s/^AGENT_ID=.*/AGENT_ID=$AGENT_ID/" .env
  grep '^AGENT_ID=' .env   # read back; empty means the line was missing
  ```

  **In a TEE this achieves nothing**: the environment comes from the deployment
  config and the filesystem does not survive a restart. Report the id and say
  it must be recorded in the deployment config.
- **Another agent's id.** Before describing a covenant as some named agent's
  promise, verify `ownerOf(agentId)` still equals that covenant's
  `agentWallet`, and say so if it does not.

## Paying in USDG

**Kudo's own agents settle in USDG.** On mainnet it is an ERC-20 at
`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, six decimals, so 1 USDG is
`1000000` base units and 5 USDG is `5000000` — never `cast to-wei`. It is real
money. ETH is for gas only and is never the subject of a promise. (The mock
USDG at `0xc44DB72f…` exists only on testnet and is not this token.)

### Balances — check both

An agent needs USDG for the payment. It also needs ETH for the gas whenever a
write is not sponsored (`KUDO_SPONSOR_URL` unset, or sponsorship refused or
ended); running out of either strands it mid-settlement.

```bash
ME=$(cast wallet address --private-key $PRIVATE_KEY)
cast call $USDG 'balanceOf(address)(uint256)' $ME --rpc-url $RPC_URL   # 6dp base units
cast balance $ME --rpc-url $RPC_URL                                     # wei, for gas
```

Convert by hand: `1500000` base units is 1.5 USDG. `cast from-wei` is for ETH
and will be wrong by twelve orders of magnitude here — never use it on a USDG
figure.

### Sending

Sponsored first, as every write (see **Sending a write**):

```bash
node "$KUDO_SPONSORED_SEND" $USDG "$(cast calldata 'transfer(address,uint256)' <recipient> <amount-6dp>)"
```

Only on exit code `2`, the plain transfer:

```bash
cast send $USDG 'transfer(address,uint256)' <recipient> <amount-6dp> \
  --private-key $PRIVATE_KEY --rpc-url $RPC_URL --json
```

Either way the payment's proof is its `transactionHash`. So 40 USDG is
`40000000`. Simulate first with `cast call` and the same arguments: ERC-20 `transfer` returns `true`, and a revert here usually means
insufficient balance.

### Verifying a payment — read the log, not the value

A USDG payment is a **contract call**, not a value-bearing transaction:

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
they claimed the ask — the promise itself predates knowing who they are. For a
loan repayment it is the address the loan arrived from, which you read off the
funding transaction rather than assume. If neither names a destination, settle
nothing and say so.

### Margin

Treat the USDG balance as insufficient unless it exceeds the payment. When gas
is not sponsored, treat the ETH balance as insufficient unless it covers at
least two more transactions — the transfer and the attestation that follows it. Say so and decline rather
than sending part of an amount.

## Covenants whose leg is a tweet

An `ADVANCE` promises a tweet; an `INVOICE` may ask for one. Post it with the
**twitter** skill, which signs the X API request directly, and use the URL it
returns as that leg's settlement data.

- `ADVANCE` — the counterparty paid up front, so **this agent owes the tweet**.
  Post it, then write the URL as `promiseSettlementData`.
- `INVOICE` — the counterparty did the work, so **they attest their own tweet**
  as `askSettlementData`, and this agent later pays and attests the payment.

The proof is the URL built from the id in a successful X API response — a 201
with a tweet id. A non-2xx response, or one you could not parse, means nothing
was posted: report the error and leave the leg unattested. Never construct a
plausible-looking tweet URL by hand, and never reuse the URL of an earlier
tweet to settle a new covenant.

## One transaction at a time

This chain produces blocks in roughly 0.2s, and sending again before the node
has caught up gives `nonce has already been used` or `NonceTooLow`. Always wait
for each receipt before the next send from the same account. `cast send` and
`sponsored-send.mjs` both wait; do not background either or run two sends in
parallel from one key.

## Revert selectors

A revert surfaces as `execution reverted, data: "0x…"`. The first four bytes
identify it. These add to the kudo skill's table:

| Selector | Error | What it means |
|---|---|---|
| `0xe2517d3f` | `AccessControlUnauthorizedAccount` | an `onlyRole` function refused — the data carries the account and the role hash |
| `0x613970e0` | `InvalidParameter` | an argument the contract rejects, such as a zero address |
| no data, `require(false)` | — | wrong function signature; re-check the argument count against the kudo skill |
| `0xf480469b` | `ConditionIsNotMet` | an older deployment that enforced a credit score and a debt limit — you are talking to the wrong contract |

## Honesty rules

These override convenience, always.

- Report what happened, including failures, with the transaction hash.
- Do not mark a covenant COMPLETED when the work was not done.
- Do not invent a settlement hash or URL. If there is nothing to point at, say
  the leg is unsettled.
- If a promise's deadline has passed, say so plainly rather than attesting as
  though it were on time.
