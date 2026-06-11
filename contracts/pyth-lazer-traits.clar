;; Title: pyth-lazer-traits
;; Version: v1
;;
;; Trait definitions for the Stacks <> Pyth Lazer oracle. See PLAN.md section 5.
;; IMMUTABLE: once deployed, the trait shapes are fixed.
;;
;; Defines `decoder-trait` (the oracle's swappable-decoder dispatch param, PLAN
;; 6.4). The price-record schema it references is locked in Phase 3; sketched here
;; for reference:
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
;; The decoder is the one swappable contract (PLAN 6.4). The oracle takes it as a
;; `<decoder-trait>` param and dispatches `decode-and-verify-price-feeds` after
;; checking the passed principal against governance's blessed decoder. The method
;; is PUBLIC in the implementation (Clarity trait methods cannot be read-only).
;;
;; No storage-trait / proxy-trait: the oracle hardcodes `.pyth-lazer-storage` and
;; consumers read storage directly (PLAN 5 / 6.4), so neither would have a caller.
(define-trait decoder-trait
	(
		(decode-and-verify-price-feeds ((buff 8192)) (response {
			timestamp: uint,
			channel: uint,
			price-feeds: (list 16 {
				feed-id: uint,
				price: (optional int),
				exponent: (optional int),
				confidence: (optional uint),
			}),
		} uint))
	)
)
