# Stacks ⇄ Pyth Lazer — Clarity contracts

Clarity 5 contracts that bring **Pyth Lazer** ("Pyth Pro") signed price feeds to Stacks.
Successor to [`stacks-pyth-bridge`](../stacks-pyth-bridge) (Pythnet + Wormhole, deprecated) — simpler: no Wormhole, no Merkle proofs.

> **Status:** Phases 1–4 complete (signatures, payload parsing, storage, oracle + governance);
> Phase 5 (hardening) underway; deployment (6) remains. Full design: [`PLAN.md`](./PLAN.md).

## How it works

A relayer fetches a Lazer update in the **`evm`** format (one secp256k1 signature over `keccak256(payload)`) and submits it on-chain.
The oracle verifies it through the decoder — signer recovery, trusted-signer check, feed parsing — then stores the latest price per feed.

## Contracts

| Contract | Mutability | Role |
|---|---|---|
| `pyth-lazer-traits` | immutable | Trait definitions |
| `pyth-lazer-decoder-v1` | **swappable** | Parse message, verify signature |
| `pyth-lazer-storage` | immutable | Permanent price storage |
| `pyth-lazer-oracle-v1` | thin / stable | Entry point for submitting updates |
| `pyth-lazer-governance` | immutable | Roles (governance/pause), trusted signers, fee, stale threshold |

Design principle — **upgrade the logic, not the state**: only the decoder and oracle carry a `-vN` suffix and are swappable; the substrate (`-traits`, `-storage`, `-governance`) is unversioned so its addresses never move. See [`PLAN.md`](./PLAN.md) §6.4.

## Clarity version

Built for **Clarity 5**. Spots that would benefit from Clarity 6 (SIP-43: `ed25519-verify`, `secp256k1-decompress?`) are marked `;; CLARITY6:` — see [`PLAN.md`](./PLAN.md) §4.1.

## Build & test

```bash
npm install   # install the clarinet-sdk + vitest harness
npm test      # compile the contracts and run the unit tests (simnet)
```

`npm test` bundles the Clarity analyzer, so the standalone `clarinet` binary isn't required. If you have it, `clarinet check` type-checks the contracts without Node.
