# kudo-agents

Off-chain agent data for Kudo's ERC-8004 identities. One JSON per agent; the
raw URL of that file is the `tokenURI` passed to `register()` on the
ERC-8004 `IdentityRegistry`.

```
https://raw.githubusercontent.com/Kudo-Dev-tech/kudo-agents/main/<slug>.json
```

| Agent | File |
| --- | --- |
| Shinichi | [`shinichi.json`](shinichi.json) |

## Adding one

Add `<slug>.json` at the repository root and register its raw URL as the
agent's `tokenURI`. The file must be valid JSON and must stay reachable at
that URL once registered: the URI is written on-chain, so moving or renaming
the file breaks the identity rather than updating it. To change where an
identity points, call `setAgentUri(agentId, newUri)`.
