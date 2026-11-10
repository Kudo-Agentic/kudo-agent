---
name: chain-forensics
description: Trace money and provenance on Robinhood Chain — read a contract's events without its ABI, follow ERC-20 transfers from address to address, and find who funded a wallet with ETH. Use when following a trail of funds, establishing who created or paid for an address, or working out the order in which transactions happened.
---

# Following a trail

Three techniques. The third is the one people miss, and it is usually the one
that attributes an anonymous wallet.

## Reading events without an ABI

You cannot fetch a contract's ABI from the chain. You can still read its logs
if you know the event's shape, because the topic is just a hash of its
signature:

```bash
cast sig-event 'Withdrawn(address,address,uint256)'
# 0xd1c19fbcd4551a5edfb66d43d2e337c04837afda3482b42bdf569a8fccdae5fb
```

Indexed parameters become topics 1, 2, 3 in order; everything else is packed
into `data`. An address in a topic is left-padded to 32 bytes, so the address
is the last 40 hex characters.

For example, a treasury contract that emits:

```
Withdrawn(address indexed operator, address indexed to, uint256 amount)
Deposited(address indexed from, uint256 amount)
```

```bash
LATEST=$(cast block-number --rpc-url $RPC_URL)
FROM=$(printf '0x%x' $((LATEST - 200000)))

cast rpc eth_getLogs "{\"address\":\"$CONTRACT\",\"fromBlock\":\"$FROM\",\"toBlock\":\"latest\",\"topics\":[\"0xd1c19fbcd4551a5edfb66d43d2e337c04837afda3482b42bdf569a8fccdae5fb\"]}" \
  --rpc-url $RPC_URL | node -e '
let s = "";
process.stdin.on("data", d => s += d).on("end", () => {
  JSON.parse(s).forEach(l => console.log(
    "operator 0x" + l.topics[1].slice(26),
    "-> 0x" + l.topics[2].slice(26),
    Number(BigInt(l.data)) / 1e6, "USDG",
    "block", Number(l.blockNumber)));
})'
```

**What a Withdrawn event does and does not tell you.** It names the address
that authorised the withdrawal. If several people share that key, it does not
tell you which of them used it. An operator address is not a person.

## Following ERC-20 transfers

`Transfer(address indexed from, address indexed to, uint256 value)`, topic0
`0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`.

Filter on topic1 for what an address **sent**, topic2 for what it
**received**. Addresses are 32-byte padded:

```bash
PAD=0x000000000000000000000000${ADDRESS#0x}

cast rpc eth_getLogs "{\"address\":\"$USDG\",\"fromBlock\":\"$FROM\",\"toBlock\":\"latest\",\"topics\":[\"0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef\",\"$PAD\"]}" \
  --rpc-url $RPC_URL | node -e '
let s = "";
process.stdin.on("data", d => s += d).on("end", () => {
  JSON.parse(s).forEach(l => console.log(
    "0x" + l.topics[1].slice(26), "->", "0x" + l.topics[2].slice(26),
    Number(BigInt(l.data)) / 1e6, "USDG", "block", Number(l.blockNumber)));
})'
```

Follow a trail by repeating this on each recipient until nothing leaves. The
last address is where the money is.

**That is where the chain stops helping.** Holding tokens says nothing about
who controls the wallet. Do not assert ownership you have not established.

## Who funded a wallet

This is the step that attributes an anonymous address, and `cast` cannot do
it. Native ETH transfers **emit no logs**, so `eth_getLogs` is blind to them
— there is nothing to filter on. Walking blocks one at a time works but is far
too slow to be useful.

Use the explorer's API, which indexes transactions by address:

```bash
curl -s "https://explorer.testnet.chain.robinhood.com/api?module=account&action=txlist&address=$ADDRESS&sort=asc" \
  | node -e '
let s = "";
process.stdin.on("data", d => s += d).on("end", () => {
  (JSON.parse(s).result || []).forEach(t => console.log(
    "block", t.blockNumber, t.from, "->", t.to,
    (Number(t.value) / 1e18).toFixed(6), "ETH"));
})'
```

Sorted ascending, the first entry is usually the wallet being funded, because
an address cannot do anything until somebody pays for its gas.

**Why this attributes.** A fresh wallet holding stolen funds tells you
nothing. The same wallet, funded for gas by a known address before it ever
received those funds, tells you who provisioned it. Money can be sent to an
address without its owner's involvement; gas has to be paid by someone who
wanted that address to be able to act.

## Order matters

Compare block numbers and say so explicitly. "Funded at 135728445, received
the stolen funds at 135729104" is evidence. The same two facts without their
order are a coincidence.

```bash
cast block <number> --rpc-url $RPC_URL --field timestamp
```

## What this can and cannot establish

It can establish that an address provisioned another address, and when.

It cannot establish that the same party signed a particular transaction. A key
can be shared, lent or stolen. When you report a conclusion drawn this way,
say which step is inference — "0xA funded the wallet that received the money"
is a fact; "0xA made the withdrawal" is an inference from it, and a reader is
entitled to see the join.
