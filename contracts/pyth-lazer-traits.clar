;; Title: pyth-lazer-traits
;; Version: v1 (scaffold; traits defined in Phase 4)
;;
;; Trait definitions for the Stacks <> Pyth Lazer oracle. See PLAN.md section 5.
;; IMMUTABLE: once deployed, the trait shapes are fixed.
;;
;; NOTE: the trait bodies are not defined yet -- they land in Phase 4 with the
;; oracle (which takes the decoder as a `<decoder-trait>` param, PLAN 6.4). The
;; price-record schema they reference is now locked (Phase 3), sketched below.
;;
;;   - Feed ids are `uint` (decision #2).
;;   - Timestamps are stored in microseconds (decision #3).
;;   - The stored price record uses a generous schema, with `(optional ...)` for
;;     fields the v1 decoder does not yet populate so storage never needs a
;;     shape change (PLAN 6.4). Locked in Phase 3 (pyth-lazer-storage):
;;
;;       { price: int, exponent: int, confidence: uint, publish-time: uint,
;;         channel: uint, ema-price: (optional int), ema-confidence: (optional uint),
;;         best-bid: (optional int), best-ask: (optional int) }
;;
;; Planned traits:
;;   - storage-trait : read / read-price-with-staleness-check / write
;;   - decoder-trait : decode-and-verify-price-feeds
;;   - proxy-trait   : read-price-feed / verify-and-update-price-feeds
