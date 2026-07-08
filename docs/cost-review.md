# Cost review — Pyth Lazer oracle

Execution-cost analysis of the on-chain hot path, measured **2026-07-08** against the
**verify-only** `pyth-lazer-oracle` (immutable core: governance state + the sole
`verify-price-feeds` entry) dispatching to the swappable `pyth-lazer-decoder-v1`. No price
storage.

**TL;DR:** the worst-case transaction — a full 16-feed update through `verify-price-feeds` —
costs **~41.9M runtime, ≈0.84% of a Stacks block**. Runtime is the only binding dimension;
the write dimensions are **zero** (verify-only stores nothing). Roughly **119 max-size
verifies fit in one block's runtime budget**, far above any realistic rate. No optimization
required.

## How to reproduce

```bash
node scripts/measure-costs.mjs
```

The script spins up simnet with `trackCosts`, trusts Pyth's production signer, widens the
staleness window (so the fixed-timestamp fixtures stay fresh), and measures two **real
PROD-signed** captured fixtures — a 3-feed crypto update (`channel 1`) and a 16-feed equity
update (`channel 3`) — through the oracle's `verify-price-feeds` entry. Two feed counts give a
linear (fixed + per-feed) model. The decoder isn't measured standalone: `verify-update` is
gated to the oracle, so `verify-price-feeds` is the only way in.

## Block budget (Stacks epoch 3.x)

| dimension | limit |
|---|---|
| runtime | 5,000,000,000 |
| read_count | 15,000 |
| read_length | 100,000,000 |
| write_count | 15,000 |
| write_length | 15,000,000 |

## Measured costs

| operation | runtime | read_cnt | read_len | write_cnt | write_len |
|---|--:|--:|--:|--:|--:|
| `verify-price-feeds` (3 feeds) | 9,626,886 | 19 | 45,943 | 0 | 0 |
| `verify-price-feeds` (16 feeds) | 41,867,978 | 19 | 45,943 | 0 | 0 |

`verify-price-feeds` is the consumer's transaction and the sole verification entry: validate
the blessed decoder, dispatch to it (signature + trusted-signer + pause checks all run inside
the decoder), enforce staleness, charge the fee, and return the parsed feeds. Being verify-only,
it performs **no writes**.

## Linear model (runtime)

≈ **2.19M fixed** (keccak256 + secp256k1 recovery + the decoder↔oracle signer/pause reads +
header parse) **+ ≈2.48M per feed** (parser compute).

These are property-rich feeds (the equity fixture carries every property) — roughly the
per-feed worst case; sparser feeds cost less.

## Worst case as a fraction of one block (16 feeds)

| dimension | share of block |
|---|--:|
| **runtime** | **0.8374%** |
| read_count | 0.1267% |
| read_length | 0.0459% |
| write_count | 0.0000% |
| write_length | 0.0000% |

Runtime is the binding dimension: ~119 such 16-feed verifies would fill a block's runtime.

## Interpretation

- **Runtime dominates; nothing is persisted.** Verify-only performs zero writes, so the write
  dimensions are flat zero. Parsing is pure buffer compute — feed count drives runtime but not
  read_count/read_length (those stay flat regardless of feed count: the fixed decoder/oracle
  reads plus contract code).
- **`get` on the threaded parse state is the per-feed cost lever.** The fold accumulator
  carries the payload `(buff 8192)`, and every `(get field state)` costs ~proportional to the
  *whole* tuple's size. The parser binds each state field once per iteration; the residual
  per-feed cost is byte reads + sign-extension + merges, irreducible for a safe parser.
- **Single entry, so the cross-contract reads are unavoidable fixed cost.** `verify-update` is
  gated to the oracle, so every verification is one `verify-price-feeds` call; the oracle→decoder
  trait dispatch and the decoder→oracle reads (trusted signers + pause) are the fixed overhead —
  there is no cheaper direct path, by design.

## Conclusion

No optimization required. A consumer can verify far more updates per block than any
deviation/heartbeat schedule needs, and with no storage the write dimensions are zero. A larger
runtime win is theoretically available — threading a per-feed *slice* instead of the whole
payload would make every remaining `get` cheap — but it adds offset-rebasing complexity for a
non-binding metric, so it is intentionally not done. Re-run `scripts/measure-costs.mjs` if the
decoder's per-feed work changes (e.g. a `-v2` decoder).
