;; Title: pyth-lazer-oracle
;; Version: v1
;;
;; Description: Write entry point that verifies updates and stores price feeds
;;
;; Hardcodes storage and governance; takes the <decoder> as a trait param and checks it
;; against governance's blessed decoder. Relayers call here; consumers read storage directly.

(use-trait decoder-trait .pyth-lazer-traits.decoder-trait)

;;;; Constants

;; Passed decoder is not the one blessed by governance
(define-constant ERR_INVALID_DECODER (err u1001))

;;;; Write entry point

(define-public (verify-and-update-price-feeds (update (buff 8192)) (decoder <decoder-trait>))
	(begin
		;; Reject while paused
		(try! (contract-call? .pyth-lazer-governance assert-active))
		;; Only the decoder governance has blessed is accepted
		(asserts! (is-eq (contract-of decoder) (contract-call? .pyth-lazer-governance get-decoder))
			ERR_INVALID_DECODER)
		(let ((decoded (try! (contract-call? decoder decode-and-verify-price-feeds update)))
				(built (build-records decoded))
				(written (try! (contract-call? .pyth-lazer-storage write (get records built)))))
			(try! (charge-fee))
			(ok written))))

;;;; Decoded feeds -> storage records

;; Fold decoded feeds into storage write records, threading in the update-level
;; publish-time and channel (a fold, not map, only so those constants can be threaded in)
(define-private (build-records (decoded {
		timestamp: uint,
		channel: uint,
		price-feeds: (list 16 { feed-id: uint, price: int, exponent: int, publisher-count: uint,
			confidence: (optional uint), best-bid: (optional int), best-ask: (optional int),
			ema-price: (optional int), ema-confidence: (optional uint),
			feed-update-timestamp: (optional uint) }),
	}))
	(fold add-record (get price-feeds decoded)
		{ publish-time: (get timestamp decoded), channel: (get channel decoded), records: (list) }))

;; Append one feed's write entry: feed-id is the storage key, the rest is the record
;; (plus the update-level publish-time and channel)
(define-private (add-record
		(feed { feed-id: uint, price: int, exponent: int, publisher-count: uint,
			confidence: (optional uint), best-bid: (optional int), best-ask: (optional int),
			ema-price: (optional int), ema-confidence: (optional uint),
			feed-update-timestamp: (optional uint) })
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
	;; NOTE: as-max-len? needs a LITERAL bound (u16), not a constant
	(merge acc { records: (unwrap-panic (as-max-len? (append (get records acc) {
		feed-id: (get feed-id feed),
		record: {
			price: (get price feed),
			exponent: (get exponent feed),
			publisher-count: (get publisher-count feed),
			confidence: (get confidence feed),
			best-bid: (get best-bid feed),
			best-ask: (get best-ask feed),
			ema-price: (get ema-price feed),
			ema-confidence: (get ema-confidence feed),
			feed-update-timestamp: (get feed-update-timestamp feed),
			publish-time: (get publish-time acc),
			channel: (get channel acc),
		},
	}) u16)) }))

;;;; Fee

;; Charge the per-update fee from the relayer to governance's fee recipient.
;; Guarded on > u0 since stx-transfer? rejects a zero amount
(define-private (charge-fee)
	(let ((fee (contract-call? .pyth-lazer-governance get-fee)))
		(if (> fee u0)
			(stx-transfer? fee tx-sender (contract-call? .pyth-lazer-governance get-fee-recipient))
			(ok true))))
