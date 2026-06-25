;; Title: pyth-lazer-traits
;; Version: v1
;;
;; IMMUTABLE trait definitions (PLAN 5). Defines `decoder-trait`, the interface of
;; the one swappable contract: the oracle takes the decoder as a `<decoder-trait>`
;; param and dispatches `decode-and-verify-price-feeds` (public, since Clarity trait
;; methods can't be read-only) after checking it against governance's blessed decoder.
;; No storage/proxy trait -- the oracle hardcodes storage and consumers read it directly.
;;
;; The per-feed shape mirrors pyth-lazer-storage's record: price/exponent/publisher-count
;; required, the rest `(optional)`. The decoder drops any feed missing the required trio,
;; so every feed it returns is storable as-is. Matches AggregatedPriceFeedData (feed ids
;; `uint`, timestamp microseconds).
(define-trait decoder-trait
	(
		(decode-and-verify-price-feeds ((buff 8192)) (response {
			timestamp: uint,
			channel: uint,
			price-feeds: (list 16 {
				feed-id: uint,
				price: int,
				exponent: int,
				publisher-count: uint,
				confidence: (optional uint),
				best-bid: (optional int),
				best-ask: (optional int),
				ema-price: (optional int),
				ema-confidence: (optional uint),
				feed-update-timestamp: (optional uint),
			}),
		} uint))
	)
)
