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
;;
;; The per-feed shape carries every property the protocol can supply, each
;; `(optional ...)` -- the decoder fills what a payload contains and leaves the
;; rest `none`; the oracle decides which are REQUIRED before storing (it rejects
;; nothing here). This list is IMMUTABLE, so it mirrors the full storage vocabulary
;; (PLAN 3.4): a future decoder can populate any field without a new trait.
;; Optionality matches `pyth-lazer-protocol`'s AggregatedPriceFeedData.
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
				publisher-count: (optional uint),
				best-bid: (optional int),
				best-ask: (optional int),
				ema-price: (optional int),
				ema-confidence: (optional uint),
				feed-update-timestamp: (optional uint),
			}),
		} uint))
	)
)
