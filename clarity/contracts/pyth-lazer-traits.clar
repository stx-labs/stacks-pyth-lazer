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
				;; Full Lazer property set, all populated by the v1 decoder. The trait carries every
				;; field so a swapped-in decoder can change coverage without reshaping this interface.
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
