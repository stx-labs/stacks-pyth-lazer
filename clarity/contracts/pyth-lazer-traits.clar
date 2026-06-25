;; Title: pyth-lazer-traits
;; Version: FINAL (immutable)
;;
;; Description: Interface of the swappable price-feed decoder
;;
;; The oracle takes the decoder as a <decoder-trait> param and dispatches
;; decode-and-verify-price-feeds after checking it against governance's blessed decoder.
;; The per-feed shape mirrors pyth-lazer-storage's record: price/exponent/publisher-count
;; required (the decoder drops feeds missing them), the rest optional. Matches
;; AggregatedPriceFeedData (feed ids uint, timestamp microseconds).
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
