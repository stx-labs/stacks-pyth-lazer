# Stacks ⇄ Pyth Lazer

Clarity contracts that bring **Pyth Lazer** ("Pyth Pro") signed price feeds to the Stacks
blockchain — the successor to [`stacks-pyth-bridge`](../stacks-pyth-bridge), which depends on
Pythnet + Wormhole (being sunset).

> **Status: Phase 0 scaffold.** Contracts are documented skeletons; protocol logic lands in
> Phases 1–6. The full design and rationale live in **[`PLAN.md`](./PLAN.md)**.

## How it works (short version)

A relayer fetches a Lazer update in the **`evm`** format (one secp256k1 ECDSA signature over
`keccak256(payload)`) and submits it on-chain. The oracle recovers the signer, checks it
against the trusted-signer set, parses the feeds, and stores the latest price per feed. No
Wormhole, no Merkle proofs — see [`PLAN.md`](./PLAN.md) §1–3.

## Contracts

| Contract | Mutability | Role |
|---|---|---|
| `pyth-lazer-traits` | immutable | trait definitions (storage / decoder / proxy) |
| `pyth-lazer-decoder-v1` | **swappable** | envelope parse + secp256k1 verify + signer check + payload parse |
| `pyth-lazer-storage` | immutable | durable `feed-id -> price` store; the stable **read anchor** |
| `pyth-lazer-oracle-v1` | thin / stable | write entry point; orchestrates decode → store → fee |
| `pyth-lazer-governance` | immutable | admin, trusted signers, fee, stale threshold (config state) |

Design principle: **upgrade the logic, not the state** — only the decoder is swappable
(see [`PLAN.md`](./PLAN.md) §6.4).

**Naming:** updateable contracts carry a `-vN` suffix (`-decoder-v1`, `-oracle-v1`) so a
successor can be deployed and switched to; the permanent substrate (`-traits`, `-storage`,
`-governance`) is unversioned so its addresses never move.

## Clarity version

Built for **Clarity 5** (`clarity_version = 5` in `Clarinet.toml`). Spots that would benefit
from **Clarity 6** (SIP-43: `secp256k1-decompress?`, `ed25519-verify`, variadic `concat`) are
marked with `;; CLARITY6:` comments — see [`PLAN.md`](./PLAN.md) §4.1.

## Quick start

```bash
clarinet check          # type-check all contracts (no Node required)
npm install             # install the clarinet-sdk + vitest test harness
npm test                # run the unit-test suite (simnet)
```

## Layout

```
contracts/        Clarity contracts (.clar)
tests/            vitest unit tests (clarinet-sdk simnet)
settings/         per-network Clarinet settings
Clarinet.toml     project + contract manifest (Clarity 5)
PLAN.md           full design, decisions, and phased build plan
```
