# Stacks ⇄ Pyth Lazer

Clarity contracts that bring **Pyth Lazer** ("Pyth Pro") signed price feeds to the Stacks blockchain.
This is the successor to [`stacks-pyth-bridge`](../../stacks-pyth-bridge), which depends on Pythnet (deprecated) + Wormhole.

> **Status: Phases 1–4 complete** (signature verification, payload parsing, storage,
> oracle + governance wiring). Hardening (Phase 5) and deployment (6) remain.
> The full design and rationale live in **[`PLAN.md`](./PLAN.md)**.

## How it works

A relayer fetches a Lazer update in the **`evm`** format (one secp256k1 ECDSA signature over `keccak256(payload)`) and submits it on-chain.
The oracle verifies the update through the decoder — signer recovery, trusted-signer check, and feed parsing — then stores the latest price per feed.

This is a simpler architecture than [`stacks-pyth-bridge`](../../stacks-pyth-bridge): no Wormhole, no Merkle proofs.

## Contracts

| Contract | Mutability | Role |
|---|---|---|
| `pyth-lazer-traits` | immutable | Trait definitions |
| `pyth-lazer-decoder-v1` | **swappable** | Parse message and verify signatures |
| `pyth-lazer-storage` | immutable | Permanent storage for price data |
| `pyth-lazer-oracle-v1` | thin / stable | Entry point for submitting feed updates |
| `pyth-lazer-governance` | immutable | Protocol governance (admin, trusted signers, fee, stale threshold) |

Design principle: **upgrade the logic, not the state** — only the decoder is swappable
(see [`PLAN.md`](./PLAN.md) §6.4).

**Naming:** updateable contracts carry a `-vN` suffix (`-decoder-v1`, `-oracle-v1`) so a
successor can be deployed and switched to; the permanent substrate (`-traits`, `-storage`,
`-governance`) is unversioned so its addresses never move.

## Clarity version

Currently built for **Clarity 5**.
Spots that would benefit from **Clarity 6** (SIP-43: `secp256k1-decompress?`, `ed25519-verify`, variadic `concat`)
are marked with `;; CLARITY6:` comments — see [`PLAN.md`](./PLAN.md) §4.1.

## Quick start

```bash
clarinet check          # type-check all contracts (no Node required)
npm install             # install the clarinet-sdk + vitest test harness
npm test                # run the unit-test suite (simnet)
```
