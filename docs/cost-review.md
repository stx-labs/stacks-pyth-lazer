# Cost review — Pyth Lazer oracle

Execution-cost analysis of the on-chain hot paths, measured **2026-06-26** against the
current `decoder-v1` (single-pass feed parser that applies the `0 → none` optional
collapse, persists price/exponent/confidence/publisher-count/best-bid/best-ask, and reads
each threaded-tuple field at most once per fold iteration).

**TL;DR:** the worst-case relayer transaction — a full 16-feed update submitted
end-to-end through the oracle — costs **~39.0M runtime, ≈0.78% of a Stacks block**.
Runtime is the only binding dimension; every other dimension stays at or below ~0.40%.
Roughly **128 max-size updates fit in one block's runtime budget** (~2,000 feeds/block),
far above any realistic relay rate. No optimization is required.

## How to reproduce

```bash
node scripts/measure-costs.mjs
```

The script (`scripts/measure-costs.mjs`) spins up simnet with `trackCosts`, trusts
Pyth's production signer, and measures two **real PROD-signed** captured fixtures — a
3-feed crypto update (`channel 1`) and a 16-feed equity update (`channel 3`) — at the
decoder's read-only verify+parse path and the oracle's public end-to-end entry point.
Two feed counts give a linear (fixed + per-feed) model.

> `recover-signer` and `decode-lazer-payload` are not listed separately: they run inside
> `decode-and-verify-price-feeds` (whose fixed term is the signature + header overhead),
> so their cost is already captured there.

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
| `decode-and-verify` (3 feeds) | 7,907,458 | 9 | 22,243 | 0 | 0 |
| `decode-and-verify` (16 feeds) | 34,868,847 | 9 | 22,243 | 0 | 0 |
| `verify-and-update` end-to-end (3 feeds) | 8,673,838 | 34 | 59,857 | 3 | 882 |
| `verify-and-update` end-to-end (16 feeds) | 39,039,875 | 60 | 60,091 | 16 | 4,704 |

`verify-and-update-price-feeds` is the relayer's actual transaction: verify + parse +
per-feed storage write + fee path. `decode-and-verify-price-feeds` is read-only (the
oracle reaches it via `contract-call?`); the SDK meters read-only calls, so it is timed
directly.

## Linear model (runtime)

- **Decode only:** ≈ **1.69M fixed** (keccak256 + secp256k1 recovery + trusted-signer
  lookup + header parse) **+ ≈2.07M per feed** (parser compute).
- **End-to-end:** ≈ **1.67M fixed + ≈2.34M per feed**. The extra ~0.26M/feed over
  decode-only is the storage write (one `map-set`, the monotonic-guard read, the print).

These are full 6-property feeds (price/exponent/confidence/best-bid/best-ask/
publisher-count all present) — roughly the per-feed worst case; sparser feeds cost less.

## Worst case as a fraction of one block (16-feed end-to-end)

| dimension | share of block |
|---|--:|
| **runtime** | **0.7808%** |
| read_count | 0.4000% |
| read_length | 0.0601% |
| write_count | 0.1067% |
| write_length | 0.0314% |

Runtime is the binding dimension: ~128 such 16-feed submits would fill a block's
runtime, i.e. ~2,000 feeds/block worth of updates.

## Interpretation

- **Runtime dominates; storage I/O is negligible.** Parsing is pure buffer compute —
  feed count drives runtime but not read_count/read_length (those stay flat at 9 reads
  for `decode-and-verify` regardless of feed count: the governance trusted-signer read
  plus contract code). Writes scale at one `map-set` per feed, trivially small.
- **`get` on the threaded parse state is the per-feed cost lever.** The fold accumulator
  carries the payload `(buff 8192)`, and every `(get field state)` costs ~proportional to
  the *whole* tuple's size, no matter the field's own type — while storing it back via
  `merge` is reference-shared and cheap. The parser binds each state field (payload,
  cursor, remaining counter) once per iteration rather than re-`get`ting it; the residual
  per-feed cost is the byte reads + sign-extension + merges, which are irreducible for a
  safe per-feed parser without sacrificing generality.
- **The `0 → none` collapse is not a regression risk.** It adds a single zero-compare
  branch per persisted field; the per-feed cost is dominated by the byte reads.

## Conclusion

No optimization required (and the cheap ones are already applied). A relayer can post
far more updates per block than any deviation/heartbeat schedule needs, and storage-cost
dimensions are nowhere near their limits. A larger win is theoretically available —
threading a per-feed *slice* instead of the whole payload would make every remaining
`get` cheap — but it adds offset-rebasing complexity for a non-binding metric, so it is
intentionally not done. Re-run `scripts/measure-costs.mjs` if the decoder's per-feed
work changes (e.g. a `-v2` decoder persisting ema-\* / funding fields).
