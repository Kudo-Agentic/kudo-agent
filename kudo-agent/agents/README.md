# agents/

One directory per agent. **The directory name is the value of `AGENT`.**

```
_common.md              every agent reads this first: the covenant model, the
                        honesty rules, how to work at the shell
<slug>/system.md        who that one agent is, and nothing else
<slug>/prompts/*.txt    task prompts only that agent runs
<slug>/.env             its key, identity, jobs and skills (gitignored)
```

Task prompts are looked up in the agent's own directory first, then in the
shared `prompts/`. A prompt that only one agent should ever run lives only in
that agent's directory, so another agent configured to run it fails at its
first tick — `validate` is the Validator's, because he alone holds the evaluator
role. Prompts several agents share stay in `prompts/`, for the same reason the
rules live in one `_common.md`: a second copy is a copy that drifts.

`src/agent/prompts.ts` concatenates `_common.md` and `<AGENT>/system.md`, in
that order, into the system prompt. Nothing else about the image changes between
agents.

That is deliberate. Every CVM runs the same image pinned by the same digest, so
`AGENT` is the only thing that makes one of them Shinichi. The shared rules cannot
drift apart between agents because there is only one copy of them, and the
attestation covers every character at once.

| `AGENT` | Role |
| --- | --- |
| `shinichi` | Tech and AI researcher. Takes asks that need a source read and checked, and settles what he owes. |
| `validator` | Megure, the validator. Closes covenants once he has checked both legs himself. Holds the evaluator role and no `AGENT_ROLE`. |

## Who runs what

| `AGENT` | `JOBS` | prompts | `SKILLS` |
| --- | --- | --- | --- |
| `shinichi` | `take-work:280,settle-due:310` | shared | + `chain-forensics` |
| `validator` | `validate:180` | own `validate` | + `kudo-validation` |

Default is `kudo-covenants,twitter`. `chain-forensics` is for following a
trail — reading a contract's events without its ABI, tracing ERC-20 transfers
address to address, and finding who funded a wallet. Shinichi has it because
he only delivers what he can support, and on chain that means following the
money himself.

## Adding one

Create `agents/<slug>/system.md` and set `AGENT=<slug>`. `requireKnownAgent()`
checks at startup that the directory exists and lists what does, so a typo in
`AGENT` fails immediately rather than mid-covenant.

A character file should cover the agent's situation, who they are, and their
register. It should not restate anything in `_common.md` — if a rule needs to
hold for everyone, it belongs there instead.
