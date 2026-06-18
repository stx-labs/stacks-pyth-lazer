# Cost review — Pyth Lazer oracle

Execution-cost analysis of the on-chain hot paths, measured **2026-06-17** against
commit `dd5e04bb70` (decoder applies the `0 → none` optional collapse and persists
price/exponent/confidence/publisher-count/best-bid/best-ask).

**TL;DR:** the worst-case relayer transaction — a full 16-feed update submitted
end-to-end through the oracle — costs **~46.1M runtime, ≈0.92% of a Stacks block**.
Runtime is the only binding dimension; reads/writes are all well under 0.4%. Roughly
**108 max-size updates fit in one block's runtime budget**, far above any realistic
relay rate. No optimization is required.

## How to reproduce

```bash
node scripts/measure-costs.mjs
```

The script (`scripts/measure-costs.mjs`) spins up simnet with `trackCosts`, trusts
Pyth's production signer, and measures two **real PROD-signed** captured fixtures — a
3-feed crypto update (`channel 1`) and a 16-feed equity update (`channel 3`) — at the
two public entry points. Two feed counts give a linear (fixed + per-feed) model.

> The read-only paths (`recover-signer`, `decode-payload`) are not listed separately:
> the SDK only meters transactions, so their cost is captured inside the public
> functions below. The `decode-and-verify` fixed term is the signature+header overhead.

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
| `decode-and-verify` (3 feeds) | 9,294,242 | 9 | 21,180 | 0 | 0 |
| `decode-and-verify` (16 feeds) | 41,826,352 | 9 | 21,180 | 0 | 0 |
| `verify-and-update` end-to-end (3 feeds) | 10,102,043 | 30 | 44,726 | 3 | 882 |
| `verify-and-update` end-to-end (16 feeds) | 46,093,804 | 56 | 44,960 | 16 | 4,704 |

`verify-and-update-price-feeds` is the relayer's actual transaction: verify +
parse + per-feed storage write + fee path.

## Linear model (runtime)

- **Decode only:** ≈ **1.79M fixed** (keccak256 + secp256k1 recovery + trusted-signer
  lookup + header parse) **+ ≈2.50M per feed** (parser compute).
- **End-to-end:** ≈ **1.80M fixed + ≈2.77M per feed**. The extra ~0.27M/feed over
  decode-only is the storage write (one `map-set`, the monotonic-guard read, the print).

These are full 6-property feeds (price/exponent/confidence/best-bid/best-ask/
publisher-count all present) — roughly the per-feed worst case; sparser feeds cost less.

## Worst case as a fraction of one block (16-feed end-to-end)

| dimension | share of block |
|---|--:|
| **runtime** | **0.9219%** |
| read_count | 0.3733% |
| read_length | 0.0450% |
| write_count | 0.1067% |
| write_length | 0.0314% |

Runtime is the binding dimension: ~108 such 16-feed submits would fill a block's
runtime, i.e. ~1,800 feeds/block worth of updates.

## Interpretation

- **Runtime dominates; storage I/O is negligible.** Parsing is pure buffer compute —
  feed count drives runtime but not read_count/read_length (those stay flat at 9 reads
  for `decode-and-verify` regardless of feed count: the governance trusted-signer read
  plus contract code). Writes scale at one `map-set` per feed (~294 write_length bytes
  per feed), trivially small.
- **The crypto is cheap relative to parsing.** The ~1.8M fixed cost (signature
  recovery + keccak256 + trusted-signer fold) is a one-time per-update overhead;
  per-feed parsing (~2.5M) overtakes it past one feed.
- **The `0 → none` collapse is not a regression risk.** It adds a single zero-compare
  branch per persisted field; the per-feed cost is dominated by the byte reads, not the
  branch.

## Conclusion

No optimization required. A relayer can post far more updates per block than any
deviation/heartbeat schedule needs, and storage-cost dimensions are nowhere near their
limits. Re-run `scripts/measure-costs.mjs` if the decoder's per-feed work changes (e.g.
a `-v2` decoder persisting ema-\* / funding fields).
