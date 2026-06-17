# Pyth Lazer relayer

> **Status: placeholder — planned, not yet built.** The architecture below was
> scoped but no code has been written. This directory reserves the structure.

## Role

A relayer is the off-chain half of the oracle. It holds a Pyth Lazer
subscription, receives signed `evm`-format price updates over Lazer's WebSocket
stream, and submits them to
[`pyth-lazer-oracle-v1.verify-and-update-price-feeds`](../clarity/contracts/pyth-lazer-oracle-v1.clar)
on Stacks. On-chain security comes from the **signature, not the caller**, so
submission is permissionless — anyone can relay a valid update (self-relay).

## Planned design

- **Canonical public pusher** (primary): a service run alongside the deployment
  that pushes updates for a configured feed set on standard triggers. Since
  submission is permissionless, consumers can also self-relay.
- **Triggers** (price-pusher model):
  - *price deviation* — push when a feed moves beyond a threshold;
  - *heartbeat* — push at least every N seconds; must be **shorter than**
    governance's stale-price threshold;
  - *on-demand* — push when a consumer requests a fresh update.
- **Cadence**: no point submitting faster than Stacks block production (~5s,
  Nakamoto). The on-chain monotonic publish-time guard skips not-newer updates.
- **Language**: TypeScript, reusing `@pythnetwork/pyth-lazer-sdk` (already a
  dev-dependency of the Clarity tests) and `@stacks/transactions`.

## Open questions (gating a real build)

Commercial/legal answers needed from Pyth before operating a production relayer:

1. Is **on-chain publication** of Lazer data to a public ledger permitted under
   the subscription tier?
2. Is **off-chain message proxying** to third parties allowed, or must each
   consumer subscribe directly?
3. What **tier / pricing** applies to an infrastructure relayer?

See [`../clarity/PLAN.md`](../clarity/PLAN.md) for the contract side.
