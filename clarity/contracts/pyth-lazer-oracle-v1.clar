;; Title: pyth-lazer-oracle
;; Version: v1
;;
;; Thin orchestrator and stable WRITE entry point (PLAN 5, 6.4). Hardcodes
;; `.pyth-lazer-storage` and `.pyth-lazer-governance`; takes the `<decoder>` as a
;; trait param and validates it against governance's blessed decoder. Relayers call
;; here; consumers READ storage directly, so this contract exposes no reads.
;;
;; `verify-and-update-price-feeds`: assert the passed decoder is the blessed one ->
;; decode + verify (signature, trusted signer, parse) -> map feeds to storage records
;; (requiring price/exponent/publisher-count, threading publish-time/channel) -> write
;; (storage runs the monotonic guard) -> charge the fee. Any step failing reverts.

(use-trait decoder-trait .pyth-lazer-traits.decoder-trait)

;;;; Constants

;; Passed decoder does not match governance's blessed decoder.
(define-constant ERR_INVALID_DECODER (err u1001))

;;;; Write entry point

(define-public (verify-and-update-price-feeds (update (buff 8192)) (decoder <decoder-trait>))
	(begin
		;; The passed decoder must be the one governance has blessed (PLAN 6.4).
		(asserts! (is-eq (contract-of decoder) (contract-call? .pyth-lazer-governance get-decoder))
			ERR_INVALID_DECODER)
		(let ((decoded (try! (contract-call? decoder decode-and-verify-price-feeds update)))
				(built (build-records decoded))
				(written (try! (contract-call? .pyth-lazer-storage write (get records built)))))
			(try! (charge-fee))
			(ok written))))

;;;; Decoded feeds -> storage records

;; Fold the decoded feeds into storage write records, threading the update-level
;; publish-time and channel. A fold (not `map`) so those constants can be threaded
;; in and so a feed missing a required field can be SKIPPED (partial success) rather
;; than mapped 1:1. The decoder hands every property as `(optional ...)`; this is
;; where v1's required fields (price, exponent, publisher-count) are enforced.
(define-private (build-records (decoded {
		timestamp: uint,
		channel: uint,
		price-feeds: (list 16 { feed-id: uint, price: (optional int), exponent: (optional int),
			confidence: (optional uint), publisher-count: (optional uint),
			best-bid: (optional int), best-ask: (optional int), ema-price: (optional int),
			ema-confidence: (optional uint), feed-update-timestamp: (optional uint) }),
	}))
	(fold add-record (get price-feeds decoded)
		{ publish-time: (get timestamp decoded), channel: (get channel decoded), records: (list) }))

;; Append one feed's storage record, or skip it. `build-record` yields `none` when a
;; required field (price, exponent, publisher-count) is absent -- a price-less feed
;; has nothing to store -- so that feed is dropped and the rest of the batch proceeds.
(define-private (add-record
		(feed { feed-id: uint, price: (optional int), exponent: (optional int),
			confidence: (optional uint), publisher-count: (optional uint),
			best-bid: (optional int), best-ask: (optional int), ema-price: (optional int),
			ema-confidence: (optional uint), feed-update-timestamp: (optional uint) })
		(acc {
			publish-time: uint,
			channel: uint,
			records: (list 16 {
				feed-id: uint,
				record: {
					price: int, exponent: int, publisher-count: uint, confidence: (optional uint),
					best-bid: (optional int), best-ask: (optional int), ema-price: (optional int),
					ema-confidence: (optional uint), feed-update-timestamp: (optional uint),
					publish-time: uint, channel: uint,
				},
			}),
		}))
	(match (build-record feed (get publish-time acc) (get channel acc))
		entry
			;; NOTE: as-max-len? needs a LITERAL bound (u16), not a constant.
			(merge acc { records: (unwrap-panic (as-max-len? (append (get records acc) entry) u16)) })
		acc))

;; Build one storage record from a decoded feed, or `none` if a v1-required field
;; (price, exponent, publisher-count) is missing. confidence / best-bid / best-ask
;; flow through as the decoder produced them; ema-* and feed-update-timestamp ride
;; through too (reserved `none` in v1, populatable by a later decoder).
(define-private (build-record
		(feed { feed-id: uint, price: (optional int), exponent: (optional int),
			confidence: (optional uint), publisher-count: (optional uint),
			best-bid: (optional int), best-ask: (optional int), ema-price: (optional int),
			ema-confidence: (optional uint), feed-update-timestamp: (optional uint) })
		(publish-time uint) (channel uint))
	(match (get price feed) price
		(match (get exponent feed) exponent
			(match (get publisher-count feed) publisher-count
				(some {
					feed-id: (get feed-id feed),
					record: {
						price: price,
						exponent: exponent,
						publisher-count: publisher-count,
						confidence: (get confidence feed),
						best-bid: (get best-bid feed),
						best-ask: (get best-ask feed),
						ema-price: (get ema-price feed),
						ema-confidence: (get ema-confidence feed),
						feed-update-timestamp: (get feed-update-timestamp feed),
						publish-time: publish-time,
						channel: channel,
					},
				})
				none)
			none)
		none))

;;;; Fee

;; Charge the per-update fee (default u0) from the relayer (tx-sender) to the admin.
;; `stx-transfer?` rejects a zero amount, so guard on it.
(define-private (charge-fee)
	(let ((fee (contract-call? .pyth-lazer-governance get-fee)))
		(if (> fee u0)
			(stx-transfer? fee tx-sender (contract-call? .pyth-lazer-governance get-admin))
			(ok true))))
