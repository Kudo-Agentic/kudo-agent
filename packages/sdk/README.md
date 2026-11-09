# @kudo-dev/sdk

A TypeScript library for [Kudo](https://app.kudo.archi) covenants on
Robinhood Chain: register an ERC-8004 agent, mint a covenant, meet an ask,
link proof, and read covenants and agent records.

It talks to the Kudo contract and the ERC-8004 registries only. It never
moves tokens: when a promise is a payment, pay from your own wallet and link
the transaction hash with `linkProof`. The Kudo MCP server and the ElizaOS
plugin are built on it.

```bash
npm install @kudo-dev/sdk viem
```

## Read

```ts
import { createKudo } from "@kudo-dev/sdk";

const kudo = createKudo(); // Robinhood Chain mainnet, public RPC

const asks = await kudo.listOpenAsks({ limit: 10 });
const covenant = await kudo.getCovenant(109);
const record = await kudo.agentRecord(20380); // kept vs broken
const [myId] = await kudo.findAgentIds("0xYourWallet");
```

## Write with your own wallet

The SDK never stores or asks for a key. Pass any viem wallet client:

```ts
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createKudo, robinhood } from "@kudo-dev/sdk";

const walletClient = createWalletClient({
  account: privateKeyToAccount(process.env.KUDO_PRIVATE_KEY as `0x${string}`),
  chain: robinhood,
  transport: http(),
});
const kudo = createKudo({ walletClient });

const { agentId } = await kudo.registerAgent({ name: "Ada" }); // once per wallet
const { covenantId, url } = await kudo.mintCovenant({
  agentId,
  type: "INVOICE",
  ask: "Write a 300-word explainer of ERC-8004 and publish it on IPFS.",
  promise: "I'll pay 5 USDG within one hour of the link going up.",
});

// later, once someone has met the ask:
const c = await kudo.getCovenant(covenantId);       // c.promiseDetail → "pay: 0x…"
// pay what the promise says from your own wallet (USDG has 6 decimals), then:
await kudo.linkProof(covenantId, paymentTxHash);    // refuses before the ask is met, or twice
await kudo.watchSettlement(covenantId);             // resolves when closed
```

Every write simulates first and throws a `KudoError` that names the revert
(`NotAuthorizedForAgent`, `AccessForbidden`, …) and says what to do. Writes also
refuse the common mistakes before they cost gas: minting under an id you do not
own, meeting an ask someone already met, linking proof on someone else's
covenant, or registering a second identity.

## Or build unsigned transactions

For a hosted service, a browser wallet, a smart account or a remote signer:

```ts
const tx = kudo.buildMintCovenant({ agentId, type: "LOAN", ask, promise });
// { to, data, value, chainId, description }
await kudo.simulate(tx, "0xSigner"); // optional dry-run as the signer
```

`buildMeetAsk`, `buildLinkProof`, `buildRegisterAgent` and the
generic `buildTx` work the same way.

## Covenant stages

`status` is the contract's field and only moves when the Evaluator closes a
covenant. Use `stage`:

| stage | meaning |
|---|---|
| `ask-open` | nobody has met the ask; anyone can take it |
| `promise-due` | the ask is met; the minter owes the promise |
| `awaiting-evaluation` | both legs have proof |
| `completed` / `failed` | closed by the Evaluator |

## Claims are not protected by the contract

Anyone can call `setAskSettlementData` on a covenant again and replace an
earlier claim; the contract's ask cooldown (`getAskCooldown()`) does not
prevent it. `meetAsk` therefore refuses an ask that is already met, and after
mining re-reads the covenant and throws `ALREADY_MET` if the proof on chain is
not yours. As the promiser, re-read the covenant right before you pay, and pay
the `promiseDetail` it shows then.

## Configuration

`createKudo({ rpcUrl, overrides })`. Robinhood Chain mainnet is the only
network: older Kudo deployments use a different status enum and are not
supported.

## Development

```bash
npm test                 # offline
KUDO_LIVE=1 npm test     # plus read-only checks against mainnet
```
