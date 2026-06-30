;; Title: pyth-lazer-traits
;; Version: FINAL (immutable)
;;
;; Description: Traits implemented by Pyth contracts

;; Interface of price-feed decoder, allows decoder to be easily updated
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
				;; Reserved tail (funding-* / market-session / ema-* / feed-update-timestamp):
				;; the full Lazer AggregatedPriceFeedData property set. The v1 decoder returns
				;; `none` for all of these; a later decoder can populate any without changing
				;; this immutable trait. (market-session is non-optional upstream, kept optional
				;; here so a decoder that does not parse it still satisfies the trait.)
				funding-rate: (optional int),
				funding-timestamp: (optional uint),
				funding-rate-interval: (optional uint),
				market-session: (optional uint),
				ema-price: (optional int),
				ema-confidence: (optional uint),
				feed-update-timestamp: (optional uint),
			}),
		} uint))
	)
)
