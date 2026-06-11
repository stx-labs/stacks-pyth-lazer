;; Title: pyth-lazer-traits
;; Version: v1
;;
;; Trait definitions for the Stacks <> Pyth Lazer oracle. See PLAN.md section 5.
;; IMMUTABLE: once deployed, the trait shapes are fixed.
;;
;; Defines `decoder-trait`, the interface of the one swappable contract (PLAN 6.4):
;; the oracle takes the decoder as a `<decoder-trait>` param and dispatches
;; `decode-and-verify-price-feeds` after checking it against governance's blessed
;; decoder. The method is PUBLIC in the implementation -- Clarity trait methods
;; cannot be read-only. (Feed ids are `uint`, decision #2; the timestamp is
;; microseconds, decision #3.)
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
