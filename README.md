# Stacks ⇄ Pyth Lazer — Clarity contracts

Clarity 5 contracts that bring **Pyth Lazer** ("Pyth Pro") signed price feeds to Stacks.
Successor to [`stacks-pyth-bridge`](../stacks-pyth-bridge) (Pythnet + Wormhole, deprecated) — simpler: no Wormhole, no Merkle proofs.

> **Status:** Phases 1–4 complete (signatures, payload parsing, oracle + governance);
> Phase 5 (hardening) underway; deployment (6) remains. Full design: [`PLAN.md`](./PLAN.md).

## How it works

A consumer (or relayer) supplies a signed Lazer update in the **`evm`** format (one secp256k1 signature over `keccak256(payload)`).
The oracle verifies it through the decoder — signer recovery, trusted-signer check, feed parsing — and **returns** the parsed feeds for use in the same transaction. Nothing is persisted on-chain: this is a verify-only oracle, matching Pyth's Lazer contracts on other chains.

## Contracts

| Contract | Mutability | Role |
|---|---|---|
| `pyth-lazer-traits` | immutable | Trait definitions |
| `pyth-lazer-oracle` | immutable | Core contract: roles (governance/pause), trusted signers, fee, stale threshold, and the `verify-price-feeds` entry |
| `pyth-lazer-decoder-v1` | **swappable** | Verify signature + parse message; invoked only by the oracle |

Verify-only: no prices are persisted on-chain — consumers get a price by submitting a fresh signed update to `pyth-lazer-oracle` (the sole verification entry) and using the returned feeds in-transaction. Only the **decoder** carries a `-vN` suffix and is swappable (the governance role selects the active decoder); the core (`pyth-lazer-traits`, `pyth-lazer-oracle`) is immutable so its addresses never move. See [`PLAN.md`](./PLAN.md).

## Clarity version

Built for **Clarity 5**. Spots that would benefit from Clarity 6 (SIP-43: `ed25519-verify`, `secp256k1-decompress?`) are marked `;; CLARITY6:` — see [`PLAN.md`](./PLAN.md) §4.1.

## Build & test

```bash
npm install   # install the clarinet-sdk + vitest harness
npm test      # compile the contracts and run the unit tests (simnet)
```

`npm test` bundles the Clarity analyzer, so the standalone `clarinet` binary isn't required. If you have it, `clarinet check` type-checks the contracts without Node.
