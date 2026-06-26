;; Title: pyth-lazer-traits
;; Version: v1
;;
;; IMMUTABLE trait definitions (PLAN 5). Defines `decoder-trait`, the interface of
;; the one swappable contract: the oracle takes the decoder as a `<decoder-trait>`
;; param and dispatches `decode-and-verify-price-feeds` (public, since Clarity trait
;; methods can't be read-only) after checking it against governance's blessed decoder.
;; No storage/proxy trait -- the oracle hardcodes storage and consumers read it directly.
;;
;; The per-feed shape carries every property the protocol can supply, each `(optional)`:
;; the decoder fills what a payload contains, the oracle decides which are REQUIRED
;; before storing. IMMUTABLE, so it mirrors the full storage vocabulary -- a future
;; decoder can populate any field without a new trait. Matches AggregatedPriceFeedData
;; (feed ids `uint`, timestamp microseconds).
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
