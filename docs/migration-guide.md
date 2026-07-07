# Pyth Legacy → Pyth Lazer Migration guide

This guide is for users of the current Wormhole-based **Pyth bridge** ([stacks-pyth-bridge](https://github.com/stx-labs/stacks-pyth-bridge)),
which will be discontinued on 2026-07-31.
You must migrate to the new **Pyth Lazer** contracts in this repo before then!

Two things change: you no longer submit price updates, and the stored price tuple has a
new shape. Reading prices is otherwise similar.

## 1. You no longer submit price feeds

On the old bridge, your transaction called `verify-and-update-price-feeds` with Wormhole
VAA bytes and an execution plan, and paid a per-update fee.

With Lazer, **our relayer submits updates for you** (a paid Pyth subscription is required
to stream Lazer data). You only read — there is no submit step in your path.

- **Need a feed we aren't relaying yet?** Request it from the Stacks Labs team.
  <!-- TODO: add the relayer request channel (contact / form / endpoint) -->
- **Don't want to depend on our relayer?** Run your own — adapt ours or build your own —
  which requires a **Pyth Pro subscription ($500/month)**.

## 2. Reading prices

Read **directly from the storage contract** — the same two read-only functions as the old
`pyth-storage-v4`, with identical behavior. Only the feed-id type changes (`(buff 32)` →
`uint`, see below); there is no storage-contract argument.

| Function | Staleness check? | vs old `pyth-storage-v4` |
|---|---|---|
| `get-price(id)` | No | unchanged |
| `read-price-with-staleness-check(id)` | Yes — errors if stale | unchanged |

**Reads no longer route through the oracle.** The old bridge also exposed read wrappers on
`pyth-oracle-v4` that took the storage contract as a trait argument, because governance
could swap the active storage contract. The new storage is immutable — its address never
moves — so you read it directly. (If you specifically called `pyth-oracle-v4.get-price` —
the one wrapper that *did* add a staleness check — use `read-price-with-staleness-check`.)

**The feed id type changed** from a 32-byte Hermes hex id to a `uint` Lazer id. Map between
them with the `hermes_id` field of the
[Lazer symbols list](https://history.pyth-lazer.dourolabs.app/history/v1/symbols). For example,
BTC/USD:

```
old:  0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43
new:  u1
```

### Return tuple

The price record grew and several fields were renamed. Access to renamed/removed fields is
the breaking part; the new fields are additive (ignore the ones you don't need).

| Old field | New field | Change |
|---|---|---|
| `price: int` | `price: int` | unchanged |
| `expo: int` | `exponent: int` | renamed |
| `conf: uint` | `confidence: (optional uint)` | renamed, now optional |
| `ema-price: int` | `ema-price: (optional int)` | now optional |
| `ema-conf: uint` | `ema-confidence: (optional uint)` | renamed, now optional |
| `publish-time: uint` | `publish-time: uint` | unchanged |
| `prev-publish-time: uint` | — | **removed** |
| — | `publisher-count: uint` | new (required) |
| — | `channel: uint` | new (required) |
| — | `best-bid: (optional int)` | new |
| — | `best-ask: (optional int)` | new |
| — | `funding-rate: (optional int)` | new |
| — | `funding-timestamp: (optional uint)` | new |
| — | `funding-rate-interval: (optional uint)` | new |
| — | `market-session: (optional uint)` | new |
| — | `feed-update-timestamp: (optional uint)` | new |

Price math is unchanged: `real_price = price × 10^exponent` (the old `expo`).

### Error codes

| Condition | Old | New |
|---|---|---|
| Feed not found | `u5004` | `u3003` |
| Stale price | `u5002` | `u3004` |

## Contracts

Read from the storage contract directly:

- **Testnet (preview):** `STJRG9Z6PB5V7588KHMF3YEZWJZN0CYX6SQHYWCY.pyth-lazer-storage`
- **Mainnet:** TBD
