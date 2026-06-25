;; Title: pyth-lazer-oracle
;; Version: v1
;;
;; Thin orchestrator and stable WRITE entry point (PLAN 5, 6.4). Hardcodes
;; `.pyth-lazer-storage` and `.pyth-lazer-governance`; takes the `<decoder>` as a
;; trait param and validates it against governance's blessed decoder. Relayers call
;; here; consumers READ storage directly, so this contract exposes no reads.
;;
;; `verify-and-update-price-feeds`: reject if the protocol is paused -> assert the passed
;; decoder is the blessed one -> decode + verify (signature, trusted signer, parse) ->
;; map feeds to storage records (threading publish-time/channel) -> write (storage runs
;; the monotonic guard) -> charge the fee. Any step failing reverts.

(use-trait decoder-trait .pyth-lazer-traits.decoder-trait)

;;;; Constants

;; Passed decoder does not match governance's blessed decoder.
(define-constant ERR_INVALID_DECODER (err u1001))

;;;; Write entry point

(define-public (verify-and-update-price-feeds (update (buff 8192)) (decoder <decoder-trait>))
	(begin
		;; Reject while the protocol is paused (governance's emergency stop).
		(try! (contract-call? .pyth-lazer-governance assert-active))
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
;; publish-time and channel into each. The decoder has already dropped feeds missing a
;; required field, so every feed maps 1:1 -- a fold (not `map`) only to thread the
;; update-level constants in.
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

;; Append one feed's storage write entry, splitting feed-id (the storage key) from the
;; record and threading in the update-level publish-time and channel.
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
	;; NOTE: as-max-len? needs a LITERAL bound (u16), not a constant.
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

;; Charge the per-update fee (default u0) from the relayer (tx-sender) to governance's
;; fee recipient. `stx-transfer?` rejects a zero amount, so guard on it.
(define-private (charge-fee)
	(let ((fee (contract-call? .pyth-lazer-governance get-fee)))
		(if (> fee u0)
			(stx-transfer? fee tx-sender (contract-call? .pyth-lazer-governance get-fee-recipient))
			(ok true))))
