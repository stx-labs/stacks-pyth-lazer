;; Title: pyth-lazer-traits
;; Version: v1 (Phase 0 scaffold)
;;
;; Trait definitions for the Stacks <> Pyth Lazer oracle. See PLAN.md section 5.
;; IMMUTABLE: once deployed, the trait shapes are fixed.
;;
;; Phase 0 NOTE: the trait bodies are intentionally not defined yet. They are
;; activated in Phase 1+ once the price-record schema is locked (PLAN 6.4,
;; decision #4). The intended interface is sketched below for reference.
;;
;;   - Feed ids are `uint` (decision #2).
;;   - Timestamps are stored in microseconds (decision #3).
;;   - The stored price record uses a generous schema, with `(optional ...)` for
;;     fields the v1 decoder does not yet populate so storage never needs a
;;     shape change (PLAN 6.4), e.g.:
;;
;;       { price: int, expo: int, conf: uint, publish-time: uint,
;;         ema-price: (optional int), ema-conf: (optional uint),
;;         best-bid: (optional int), best-ask: (optional int) }
;;
;; Planned traits:
;;   - storage-trait : read / read-price-with-staleness-check / write
;;   - decoder-trait : decode-and-verify-price-feeds
;;   - proxy-trait   : read-price-feed / verify-and-update-price-feeds
