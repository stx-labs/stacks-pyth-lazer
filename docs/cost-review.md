# Cost review — Pyth Lazer oracle

Execution-cost analysis of the on-chain hot paths, measured **2026-07-07** against the
**verify-only** `decoder-v1` + `pyth-lazer-oracle` (governance and the verify entry merged
into one immutable contract): the oracle validates the blessed decoder,
dispatches to `decode-and-verify-price-feeds`, enforces the staleness window + fee, and
returns the parsed feeds. Nothing is written on-chain.

**TL;DR:** the worst-case transaction — a full 16-feed update verified end-to-end through
the oracle — costs **~41.9M runtime, ≈0.84% of a Stacks block**. Runtime is the only
binding dimension; the write dimensions are **zero** (verify-only stores nothing).
Roughly **119 max-size verifies fit in one block's runtime budget**, far above any
realistic rate. No optimization required.

## How to reproduce

```bash
node scripts/measure-costs.mjs
```

The script spins up simnet with `trackCosts`, trusts Pyth's production signer, widens the
staleness window (so the fixed-timestamp fixtures stay fresh), and measures two **real
PROD-signed** captured fixtures — a 3-feed crypto update (`channel 1`) and a 16-feed equity
update (`channel 3`) — at the decoder's read-only verify+parse path and the oracle's public
end-to-end entry point. Two feed counts give a linear (fixed + per-feed) model.

> `recover-signer` and `decode-lazer-payload` are not listed separately: they run inside
> `decode-and-verify-price-feeds`, so their cost is already captured there.

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
| `decode-and-verify` (3 feeds) | 9,586,502 | 12 | 38,011 | 0 | 0 |
| `decode-and-verify` (16 feeds) | 41,796,706 | 12 | 38,011 | 0 | 0 |
| `verify-price-feeds` end-to-end (3 feeds) | 9,627,103 | 19 | 47,031 | 0 | 0 |
| `verify-price-feeds` end-to-end (16 feeds) | 41,868,195 | 19 | 47,031 | 0 | 0 |

`verify-price-feeds` is the consumer's transaction: validate the blessed decoder, verify +
parse (via `contract-call?`), enforce staleness, charge the fee, return the feeds. It adds
only a thin fixed overhead over the decoder's read-only path (~71K runtime + ~7 reads for
the decoder-authorization / staleness / fee logic — all intra-contract now that governance
and the oracle are one contract) and — being verify-only — performs **no writes**.
`decode-and-verify-price-feeds` is read-only (the oracle reaches it via `contract-call?`);
the SDK meters read-only calls, so it is timed directly.

## Linear model (runtime)

- **Decode only:** ≈ **2.15M fixed** (keccak256 + secp256k1 recovery + the oracle
  trusted-signer & pause reads + header parse) **+ ≈2.48M per feed** (parser compute).
- **End-to-end:** the same per-feed slope; the oracle adds only a small fixed overhead
  (decoder-authorization + staleness + fee), and no write.

These are property-rich feeds (the equity fixture carries every property) — roughly the
per-feed worst case; sparser feeds cost less.

## Worst case as a fraction of one block (16-feed end-to-end)

| dimension | share of block |
|---|--:|
| **runtime** | **0.8374%** |
| read_count | 0.1267% |
| read_length | 0.0470% |
| write_count | 0.0000% |
| write_length | 0.0000% |

Runtime is the binding dimension: ~119 such 16-feed verifies would fill a block's runtime.

## Interpretation

- **Runtime dominates; nothing is persisted.** Verify-only performs zero writes, so the
  write dimensions are flat zero. Parsing is pure buffer compute — feed count drives runtime
  but not read_count/read_length (those stay flat regardless of feed count: the oracle reads
  plus contract code).
- **Merging governance into the oracle trimmed the read dimensions.** The oracle's
  decoder-authorization / staleness / fee reads are now intra-contract `var-get`s rather than
  cross-contract calls, dropping the end-to-end path from 28→19 reads with runtime unchanged.
- **`get` on the threaded parse state is the per-feed cost lever.** The fold accumulator
  carries the payload `(buff 8192)`, and every `(get field state)` costs ~proportional to the
  *whole* tuple's size. The parser binds each state field once per iteration; the residual
  per-feed cost is byte reads + sign-extension + merges, irreducible for a safe parser.
- **The pause kill-switch still costs a per-call read.** The decoder is a separate contract,
  so its `verify-update` pause check + trusted-signer read are cross-contract reads into the
  oracle on every verify — a small fixed overhead, the price of pause covering both the oracle
  path and direct decoder calls.

## Conclusion

No optimization required. A consumer can verify far more updates per block than any
deviation/heartbeat schedule needs, and being verify-only, the write dimensions are zero.
A larger runtime win is theoretically available — threading a per-feed *slice* instead of
the whole payload would make every remaining `get` cheap — but it adds offset-rebasing
complexity for a non-binding metric, so it is intentionally not done. Re-run
`scripts/measure-costs.mjs` if the decoder's per-feed work changes (e.g. a `-v2` decoder).
