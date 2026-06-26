;; Title: pyth-lazer-oracle
;; Version: v1
;;
;; Description: Entry point for submitting Pyth price feeds. Called by relayer
;;
;; Hardcodes storage and governance, but takes the <decoder> as a trait param and checks it
;; against governance's authorized decoder

(use-trait decoder-trait .pyth-lazer-traits.decoder-trait)

;;;; Constants

;; Passed decoder is not the authorized one
(define-constant ERR_INVALID_DECODER (err u1001))

;;;; Public functions

;; Entrypoint for submitting price feeds. Called by relayer
(define-public (verify-and-update-price-feeds (update (buff 8192)) (decoder <decoder-trait>))
	(begin
		;; Reject while paused
		(try! (contract-call? .pyth-lazer-governance assert-active))
		;; Only authorized decoder is allowed
		(asserts! (is-eq (contract-of decoder) (contract-call? .pyth-lazer-governance get-decoder))
			ERR_INVALID_DECODER)
		(let ((decoded (try! (contract-call? decoder decode-and-verify-price-feeds update)))
				(built (build-records decoded))
				(written (try! (contract-call? .pyth-lazer-storage write (get records built)))))
			(try! (charge-fee))
			(ok written))))

;;;; Private functions

;; Transform parsed Pyth message into records we can write to storage contract
(define-private (build-records
		(decoded {
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
				feed-update-timestamp: (optional uint)
			})
		}))
	(fold add-record (get price-feeds decoded) {
		publish-time: (get timestamp decoded),
		channel: (get channel decoded),
		records: (list)
	}))

;; Extract `feed-id` from record, add `publish-time` and `channel`
(define-private (add-record
		(feed {
			feed-id: uint,
			price: int,
			exponent: int,
			publisher-count: uint,
			confidence: (optional uint),
			best-bid: (optional int),
			best-ask: (optional int),
			ema-price: (optional int),
			ema-confidence: (optional uint),
			feed-update-timestamp: (optional uint)
		})
		(acc {
			publish-time: uint,
			channel: uint,
			records: (list 16 {
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
			}),
		}))
	(merge acc {
		;; #[allow(panic)]
		records: (unwrap-panic (as-max-len? (append (get records acc) {
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
			}
		}) u16)) ;; NOTE: `as-max-len?` needs a LITERAL bound, not a constant
	}))

;; Charge fee to `tx-sender` for submitting price feeds
(define-private (charge-fee)
	(let ((fee (contract-call? .pyth-lazer-governance get-fee)))
		(if (> fee u0)
			(stx-transfer? fee tx-sender (contract-call? .pyth-lazer-governance get-fee-recipient))
			(ok true))))
