# Stacks ⇄ Pyth Lazer — Clarity contracts

Clarity 5 contracts that bring **Pyth Lazer** ("Pyth Pro") signed price feeds to Stacks.
Successor to [`stacks-pyth-bridge`](../stacks-pyth-bridge) (Pythnet + Wormhole, deprecated) — simpler: no Wormhole, no Merkle proofs.

> **Status:** Phases 1–4 complete (signatures, payload parsing, storage, oracle + governance);
> Phase 5 (hardening) underway; deployment (6) remains. Full design: [`PLAN.md`](./PLAN.md).

## How it works

A consumer (or relayer) supplies a signed Lazer update in the **`evm`** format (one secp256k1 signature over `keccak256(payload)`).
The oracle verifies it through the decoder — signer recovery, trusted-signer check, feed parsing — and **returns** the parsed feeds for use in the same transaction. Nothing is stored on-chain: this is a verify-only oracle, matching Pyth's Lazer contracts on other chains.

## Contracts

| Contract | Mutability | Role |
|---|---|---|
| `pyth-lazer-traits` | immutable | Trait definitions |
| `pyth-lazer-decoder-v1` | **swappable** | Verify signature + parse message; returns the feeds (directly callable, read-only) |
| `pyth-lazer-oracle-v1` | thin / stable | Verify-only entry: validates the blessed decoder, enforces staleness + fee, returns the feeds |
| `pyth-lazer-governance` | immutable | Roles (governance/pause), trusted signers, fee, stale threshold |

Verify-only: the oracle holds no state and stores no prices — consumers read a price by submitting a fresh signed update (via the oracle, or the decoder directly) and using the returned feeds in-transaction. Only the decoder and oracle carry a `-vN` suffix and are swappable; the substrate (`-traits`, `-governance`) is unversioned so its addresses never move. See [`PLAN.md`](./PLAN.md).

## Clarity version

Built for **Clarity 5**. Spots that would benefit from Clarity 6 (SIP-43: `ed25519-verify`, `secp256k1-decompress?`) are marked `;; CLARITY6:` — see [`PLAN.md`](./PLAN.md) §4.1.

## Build & test

```bash
npm install   # install the clarinet-sdk + vitest harness
npm test      # compile the contracts and run the unit tests (simnet)
```

`npm test` bundles the Clarity analyzer, so the standalone `clarinet` binary isn't required. If you have it, `clarinet check` type-checks the contracts without Node.
