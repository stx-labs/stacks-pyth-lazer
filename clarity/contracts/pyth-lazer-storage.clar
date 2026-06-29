;; Title: pyth-lazer-storage
;; Version: FINAL (immutable)
;;
;; Description: Immutable storage of Pyth price feeds

;;;; Constants

;; Caller is not authorized
(define-constant ERR_UNAUTHORIZED (err u3001))
;; No record stored for this feed-id
(define-constant ERR_PRICE_FEED_NOT_FOUND (err u3003))
;; Stored price is older than the governance staleness window
(define-constant ERR_STALE_PRICE (err u3004))
;; Could not read wall-clock time from the chain
(define-constant ERR_NO_BLOCK_TIME (err u3005))

;; Lazer publish-time is microseconds; staleness compares in seconds
(define-constant MICROS_PER_SECOND u1000000)

;;;; Data vars / maps

(define-data-var authorized-writer principal .pyth-lazer-oracle-v1)

;; feed-id -> price record. Optional/required split mirrors
;; `pyth-lazer-protocol`'s AggregatedPriceFeedData (verified on live evm updates):
;;   - REQUIRED `price` / `exponent` / `publisher-count`. Only `price` is protocol-
;;     optional; the ORACLE skips a price-less feed (partial success) rather than
;;     rejecting the batch. `publish-time` (update timestamp, microseconds) and
;;     `channel` are supplied by the oracle; channel is recorded, not enforced.
;;   - OPTIONAL `confidence` / `best-bid` / `best-ask` / `ema-*` /
;;     `feed-update-timestamp`. The v1 decoder fills the first three; the rest are
;;     reserved `none` so a later decoder can populate them without reshaping this
;;     IMMUTABLE schema.
(define-map prices uint {
	price: int,
	exponent: int,
	publisher-count: uint,
	confidence: (optional uint),
	best-bid: (optional int),
	best-ask: (optional int),
	ema-price: (optional int),
	ema-confidence: (optional uint),
	feed-update-timestamp: (optional uint),
	publish-time: uint,
	channel: uint,
})

;;;; Read-only API

(define-read-only (get-authorized-writer)
	(var-get authorized-writer))

;; Read price feed data with no staleness check
(define-read-only (get-price (feed-id uint))
	(ok (unwrap! (map-get? prices feed-id) ERR_PRICE_FEED_NOT_FOUND)))

;; Read price feed data, returning an error if data is stale
(define-read-only (read-price-with-staleness-check (feed-id uint))
	(let ((entry (unwrap! (map-get? prices feed-id) ERR_PRICE_FEED_NOT_FOUND))
			(threshold (contract-call? .pyth-lazer-governance get-stale-price-threshold))
			(now (unwrap! (get-stacks-block-info? time (- stacks-block-height u1)) ERR_NO_BLOCK_TIME))
			(publish-time-seconds (/ (get publish-time entry) MICROS_PER_SECOND)))
		;; Fresh while `now - publish-time-seconds <= threshold`, rearranged to
		;; `publish + threshold >= now` so a publish-time ahead of block time (Lazer and
		;; Stacks keep independent clocks) reads as fresh rather than underflowing the uint
		(asserts! (>= (+ publish-time-seconds threshold) now) ERR_STALE_PRICE)
		(ok entry)))

;;;; Write API (authorized-writer only)

;; Batch-write up to 16 price feeds
;; Updates not newer than what we already have are skipped
;; Returns the number of feeds actually written
;;
;; NOTE: Caller is responsible for checking if protocol is paused!
(define-public (write (batch (list 16 {
		feed-id: uint,
		record: {
			price: int,
			exponent: int,
			publisher-count: uint,
			confidence: (optional uint),
			best-bid: (optional int),
			best-ask: (optional int),
			ema-price: (optional int),
			ema-confidence: (optional uint),
			feed-update-timestamp: (optional uint),
			publish-time: uint,
			channel: uint,
		},
	})))
	(begin
		(asserts! (is-eq contract-caller (var-get authorized-writer)) ERR_UNAUTHORIZED)
		(ok (fold write-entry batch u0))))

;; Fold step: Update single price feed
;; Updates not newer than what we already have are skipped
(define-private (write-entry
		(entry {
			feed-id: uint,
			record: {
				price: int,
				exponent: int,
				publisher-count: uint,
				confidence: (optional uint),
				best-bid: (optional int),
				best-ask: (optional int),
				ema-price: (optional int),
				ema-confidence: (optional uint),
				feed-update-timestamp: (optional uint),
				publish-time: uint,
				channel: uint,
			},
		})
		(written uint))
	(let ((feed-id (get feed-id entry))
			(record (get record entry)))
		(if (is-update-newer feed-id (get publish-time record))
			(begin
				(map-set prices feed-id record)
				(print { type: "price-feed", action: "updated", data: entry })
				(+ written u1))
			written)))

;; The replay/monotonic guard: an update is accepted only when its publish-time is
;; strictly newer than the stored time
(define-private (is-update-newer (feed-id uint) (publish-time uint))
	(match (map-get? prices feed-id)
		existing (> publish-time (get publish-time existing))
		true))

;;;; Admin API (governance role, via the governance contract)

;; Set new authorized writer
(define-public (set-authorized-writer (new-writer principal))
	(begin
		(try! (contract-call? .pyth-lazer-governance assert-active))
		(try! (contract-call? .pyth-lazer-governance assert-governance contract-caller))
		(var-set authorized-writer new-writer)
		(print { type: "authorized-writer", action: "updated", data: { new-writer: new-writer } })
		(ok true)))
