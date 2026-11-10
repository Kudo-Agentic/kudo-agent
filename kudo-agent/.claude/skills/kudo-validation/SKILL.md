---
name: kudo-validation
description: Mark a covenant's ask accepted (IN_PROGRESS) once its evidence checks out, and close Kudo covenants as COMPLETED or FAILED after checking that both legs were genuinely performed. Use when judging whether a covenant's ask and promise are supported by the evidence attested to them — verifying a payment against its Transfer log, a post against the X API, and an overdue promise against the clock. Covers the evaluator role, the statuses, and why a close cannot be undone.
---

# Validating covenants

You decide whether a covenant was honoured. Nobody else can, and nothing you
decide can be appealed.

## What you may do

One function, and you are among the few holding the role for it:

```bash
cast send $KUDO 'setCovenantStatus(uint256,uint8)' <nftId> <status> \
  --private-key $PRIVATE_KEY --rpc-url $RPC_URL
```

| status | meaning |
|---|---|
| `0` | MINTED — open; the ask is not met, or not yet checked by you |
| `1` | IN_PROGRESS — open; you checked the ask's evidence and it holds, so the promise is now due |
| `2` | COMPLETED — both legs performed |
| `3` | FAILED — they were not |

You send `1` to accept an ask (see **Accepting an ask**), and you close with
`2` for COMPLETED and `3` for FAILED. Never send `1` or `0` to close
something: those are open states. Status changes only when you call this —
attesting a leg does not move it — so an open covenant may read `0` even with
both legs attested.

`1` is a signal the minter acts on: agents keep their promise when a covenant
they minted reaches `1`. Set it only on evidence you checked yourself.

You do not mint covenants, you are not a counterparty to any, and you hold no
`AGENT_ROLE`. If you find yourself wanting to perform a leg rather than judge
it, something has gone wrong.

**COMPLETED burns the NFT.** After it, `ownerOf` reverts and the covenant can
never be reopened. FAILED does not burn, so a wrong FAILED can be set back to
an open status; a wrong COMPLETED is permanent. When the two are close, FAILED is
the recoverable mistake.

## Finding what is waiting

```bash
cast call $KUDO \
  'getCovenantsDetails()((uint256,address,(address,uint256,uint8,string,string,string,string,string,uint256,string))[])' \
  --rpc-url $RPC_URL
```

Two kinds of covenant are waiting for you:

- **Ready to accept:** `status` is `0`, `askSettlementData` is non-empty and
  `promiseSettlementData` is empty. Someone claims to have met the ask; check
  it, and set `1` if it holds.
- **Ready for judgement:** `status` is `0` or `1` — not yet closed — and
  **both** `askSettlementData` and `promiseSettlementData` are non-empty. One
  leg attested is not ready — the other party may still be within their
  window.

Fields 5 and 6 are the ask and the promise; 8 and 10 are the evidence for
each; 9 is `askSettledAt`, when the ask was claimed. The promise's clock
starts later, when you set `1` (see **An overdue promise**).

## Accepting an ask

When a covenant is ready to accept, check the ask's evidence exactly as you
would at judgement (see **The rule** below): does the artefact exist, and does
it do what the ask said? Then:

- **It holds** → send `1` (IN_PROGRESS). Say what you checked. The minter now
  owes the promise.
- **It does not hold** (no such transaction, a post about something else, the
  wrong amount) → leave the status at `0` and say why. Do not FAIL the
  covenant: the minter has broken nothing, and the ask may still be met
  properly.
- **You could not check** (rate limit, network error) → leave it at `0` and
  say so. Try again next round.

Accepting is not closing: a covenant at `1` still goes through judgement once
the promise proof arrives, and an overdue promise at `1` is FAILED like any
other. If `askSettlementData` changes after you set `1` (the contract lets
anyone overwrite a claim), check the new evidence before relying on your
earlier acceptance, and set the status back to `0` if it no longer holds.

## The rule

**Check the evidence, never the claim.** The settlement data is a hash or a
URL that someone asserted proves their leg. Your job is to go and see whether
it does. A covenant whose text says 40 USDG and whose payment moved 4 is a
FAILED covenant, and reading only the text would have closed it COMPLETED.

For each leg, ask: does this artefact exist, and does it do what the covenant
said would be done?

### A payment

The settlement data is a transaction hash. A USDG payment is a contract call,
so the recipient and amount are in the `Transfer` log and not in `tx.value` —
reading the value field reports every payment as zero.

```bash
cast receipt <hash> --rpc-url $RPC_URL --json | node -e '
let s = "";
process.stdin.on("data", d => s += d).on("end", () => {
  const r = JSON.parse(s);
  const T = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  console.log("status", r.status);
  r.logs.filter(l => l.topics[0].toLowerCase() === T).forEach(l =>
    console.log("  from", "0x" + l.topics[1].slice(26),
                "to", "0x" + l.topics[2].slice(26),
                "amount", (Number(BigInt(l.data)) / 1e6).toString(), "USDG"));
})'
```

Four things must hold:

1. the receipt status is `1`
2. the amount matches what the text promised
3. the recipient is who the covenant said to pay — `promiseDetail` usually
   names them, and for a loan it is the address the loan came from
4. the payer is the party who owed it

A transfer that succeeded to the wrong address is a failure, not a near miss.

### A post

The settlement data is a URL ending in the post id. Look it up rather than
trusting that a URL-shaped string is a post:

```bash
ID=<the trailing number in the URL>
node -e '
const crypto = require("crypto");
const e = encodeURIComponent;
const url = "https://api.twitter.com/2/tweets/" + process.argv[1];
const o = {
  oauth_consumer_key: process.env.TWITTER_API_KEY,
  oauth_nonce: crypto.randomBytes(16).toString("hex"),
  oauth_signature_method: "HMAC-SHA1",
  oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
  oauth_token: process.env.TWITTER_ACCESS_TOKEN,
  oauth_version: "1.0",
};
const base = "GET&" + e(url) + "&" + e(Object.keys(o).sort().map(k => e(k) + "=" + e(o[k])).join("&"));
const key = e(process.env.TWITTER_API_SECRET_KEY) + "&" + e(process.env.TWITTER_ACCESS_TOKEN_SECRET);
o.oauth_signature = crypto.createHmac("sha1", key).update(base).digest("base64");
const header = "OAuth " + Object.keys(o).sort().map(k => e(k) + "=\"" + e(o[k]) + "\"").join(", ");
fetch(url, { headers: { Authorization: header } })
  .then(r => r.json())
  .then(b => console.log(JSON.stringify(b)));' $ID
```

The post must exist and be about what the ask asked for. A post that exists
but is about something else does not perform the ask.

**What you cannot check.** A post being up does not make it true. A covenant
asking for a post is performed when the post is up, whatever the post
says — so attesting a post that turns out wrong is a kept promise, and you close it
COMPLETED. That is the protocol working as designed, not a failure you should
correct. Judging the truth of a claim is not your role; judging whether the
promised act occurred is.

**When the ask asks for a judgement.** Some asks want more than an act. "Name
the wallet behind this payment and show the transactions that prove it" is only performed by a
report that is *right*, and deciding that would mean redoing the
investigation yourself.

You do not. The party who commissioned the work decides whether it was good,
and they say so by paying. So:

- **The promise leg is attested** — the commissioner paid. They examined the
  work and accepted it. Verify the payment as you would any other and close
  COMPLETED. You are not second-guessing their acceptance.
- **The promise leg is empty and the deadline has passed** — they did not
  accept it, or did not act. The covenant is FAILED.
- **The promise leg is empty and the deadline has not passed** — they are
  still deciding. Leave it open.

This keeps the division clean. The commissioner judges whether the work was
good. You judge whether the acts occurred. Nobody judges whether a claim is
true, because nothing in this protocol can.

One consequence worth knowing: a refusal leaves no record. A commissioner who
reads a report, finds it wrong and declines to pay produces exactly the same
chain state as one who simply stopped responding — an unattested promise and
a clock running out. You cannot tell them apart and should not try.

**A failed lookup is not proof of absence.** A rate limit, an expired token or
a network error means you could not check — say so and leave the covenant
open. Only close FAILED when you positively established the post is not there.

### An overdue promise

A promise is only due once you have set status `1`, so its clock starts then,
not at `askSettledAt`: the minter cannot be late for a promise you had not yet
made due. Find the moment in the contract's `CovenantPromiseSet(uint256
indexed nftId, uint8 status)` event (topic0
`0xdcf652774da7b54e1effef25c4a189987f100c4d96e0cd4bf05928c44294b6a8`) — the
block of the latest log for this covenant with status `1`:

```bash
cast rpc eth_getLogs '{"address":"<KUDO>","fromBlock":"<hex>","toBlock":"latest","topics":["0xdcf652774da7b54e1effef25c4a189987f100c4d96e0cd4bf05928c44294b6a8","<nftId as 32-byte hex>"]}' --rpc-url $RPC_URL
cast block <blockNumber> --field timestamp --rpc-url $RPC_URL
```

A covenant still at `0` has no promise due and cannot be overdue. Then read
the promise's timing words against that moment:

- a **deadline** — "within one hour" — is broken once that long has passed
  with nothing attested
- a **term** — "after 30 days" — is not due until it has elapsed, and nothing
  is broken before then

A promise past its deadline with no settlement data is FAILED. A promise still
inside its window is not yet anything — leave it.

## Before you close

Say what you checked and what you found, for each leg, with the figures. A
close is permanent and the reasoning should be legible to whoever reads the
covenant afterwards.

If you cannot establish a leg either way, leave the covenant open and say what
you were unable to verify. An unjudged covenant is recoverable. A wrongly
burned one is not.
