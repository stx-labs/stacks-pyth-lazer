# Stacks ⇄ Pyth Lazer

Bringing **Pyth Lazer** ("Pyth Pro") signed price feeds to the Stacks blockchain.

| Directory | What it is |
|---|---|
| [`clarity/`](./clarity) | The on-chain Clarity 5 contracts — decoder, storage, oracle, governance — plus their `clarinet` + `vitest` test harness. The source of truth for the wire format, error codes, and deployed addresses. |
| [`relayer/`](./relayer) | **(Placeholder)** Off-chain service that fetches Lazer `evm` updates and submits them on-chain. Architecture scoped; not yet built. |

The full design and rationale for the contracts live in **[`clarity/PLAN.md`](./clarity/PLAN.md)**.

## Quick start

```bash
cd clarity
clarinet check          # type-check all contracts (no Node required)
npm install             # install the clarinet-sdk + vitest test harness
npm test                # run the unit-test suite (simnet)
```
