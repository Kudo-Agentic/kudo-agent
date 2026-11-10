# @kudo-dev/plugin-kudo

[Kudo](https://app.kudo.archi) for [ElizaOS](https://elizaos.ai) agents: an
Eliza agent can register an ERC-8004 identity, mint covenants, take open asks,
and link proof on Robinhood Chain. It never moves tokens: the agent pays from
its own wallet and links the transaction hash.

```bash
bun add @kudo-dev/plugin-kudo
```

```json
{
  "name": "Ada",
  "plugins": ["@elizaos/plugin-bootstrap", "@kudo-dev/plugin-kudo"],
  "settings": {
    "secrets": {
      "KUDO_PRIVATE_KEY": "0x…",
      "KUDO_AGENT_ID": "123"
    }
  }
}
```

Or in code: `import { kudoPlugin } from "@kudo-dev/plugin-kudo"`.

| Setting | |
|---|---|
| `KUDO_KEY_SOURCE` | where the signing key comes from: `env` (default) or `dstack` |
| `KUDO_PRIVATE_KEY` | the agent's wallet key when `KUDO_KEY_SOURCE=env`. Without a key the plugin is read-only and write actions are not offered. |
| `KUDO_DSTACK_KEY_PATH` | with `dstack`: the key path, default `kudo/agent` (the same wallet the Kudo skill derives) |
| `KUDO_DSTACK_SOCKET` | with `dstack`: default `/var/run/dstack.sock` |
| `KUDO_AGENT_ID` | its ERC-8004 id. No id yet? Say *"register yourself on Kudo"*. |
| `KUDO_RPC_URL` | RPC override |

### Running in a Phala TEE

Set `KUDO_KEY_SOURCE=dstack` and leave `KUDO_PRIVATE_KEY` unset. The key is
then derived by dstack inside the enclave: it never exists outside it, and it
is the same on every restart of the same app, so the agent keeps its wallet
and identity. Redeploying as a new Phala app gives a new key and wallet.

With `dstack` the plugin never falls back to another key: if the dstack socket
cannot be reached, the plugin fails at startup and says so. A
`KUDO_PRIVATE_KEY` set alongside it is ignored, with a warning.

## Actions

`GET_KUDO_WALLET`, `REGISTER_KUDO_AGENT`, `SET_KUDO_AGENT_METADATA`,
`GET_COVENANTS_DETAILS`, `GET_COVENANT`, `MINT_COVENANT`,
`SET_ASK_SETTLEMENT_DATA`, `SET_PROMISE_SETTLEMENT_DATA`, `GET_KUDO_AGENT`.
Each is the MCP tool's name in capitals, except that the generic registry
ones (`register`, `set_metadata`) and the two combined reads carry `KUDO` so
they cannot clash with another plugin's actions. Earlier names
(`KUDO_STATUS`, `LIST_OPEN_ASKS`, `MEET_ASK`, `LINK_PROOF`, `CLAIM_ASK`, …)
remain as similes.

A promise is due only once the Evaluator has accepted the claim on its ask
(status `IN_PROGRESS`): the `KUDO` provider lists those, and
`SET_PROMISE_SETTLEMENT_DATA` refuses anything earlier.

With `KUDO_KEY_SOURCE=dstack` the plugin also reads the enclave's Phala app id
from dstack: `REGISTER_KUDO_AGENT` records it as `teeId`, and
`SET_KUDO_AGENT_METADATA` with key `teeId` refreshes a stale one. Outside a
TEE no `teeId` is ever written.

Each wraps the same tool as the Kudo MCP server. The runtime's small model
fills in the arguments from the conversation; the tool's schema validates them
before anything is signed, and every write simulates first.

The `KUDO` provider puts the agent's wallet, agent id and any promises it
currently owes into context, so it remembers to keep them.

Give the wallet a little ETH for gas on Robinhood Chain. Promising needs no
tokens up front; the agent needs whatever token it promised only by the time
a payment is due.
