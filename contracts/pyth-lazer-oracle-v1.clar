;; Title: pyth-lazer-oracle
;; Version: v1
;;
;; Thin orchestrator and stable WRITE entry point (PLAN 5, 6.4). Hardcodes
;; `.pyth-lazer-storage` and `.pyth-lazer-governance`; takes the `<decoder>` as a
;; trait param and validates it against governance's blessed decoder; charges the
;; per-update fee. Relayers call here to submit updates; consumers READ storage
;; directly (it is the stable read anchor), so this contract exposes no reads.
;;
;; Flow of `verify-and-update-price-feeds`:
;;   1. assert the passed decoder == governance's blessed decoder (PLAN 6.4);
;;   2. decode + verify the update (signature, trusted signer, payload parse);
;;   3. map decoded feeds -> storage records, threading the update's publish-time
;;      and channel and ENFORCING the required core fields (storage's FIXME);
;;   4. write to storage (monotonic guard runs there);
;;   5. charge the fee (default u0). Any step failing reverts the whole tx.

(use-trait decoder-trait .pyth-lazer-traits.decoder-trait)

;;;; Constants

;; Passed decoder does not match governance's blessed decoder.
(define-constant ERR_INVALID_DECODER (err u1001))
;; (u1002 retired: the blessed decoder now has a default, so "no decoder" is unreachable.)
;; A decoded feed is missing a core field the v1 record requires. Per-field codes
;; so a relayer can see which property its subscription dropped (storage FIXME).
(define-constant ERR_MISSING_PRICE (err u1003))
(define-constant ERR_MISSING_EXPONENT (err u1004))
(define-constant ERR_MISSING_CONFIDENCE (err u1005))

;;;; Write entry point

(define-public (verify-and-update-price-feeds (update (buff 8192)) (decoder <decoder-trait>))
	(begin
		;; The passed decoder must be the one governance has blessed (PLAN 6.4).
		(asserts! (is-eq (contract-of decoder) (contract-call? .pyth-lazer-governance get-decoder))
			ERR_INVALID_DECODER)
		(let ((decoded (try! (contract-call? decoder decode-and-verify-price-feeds update)))
				(built (try! (build-records decoded)))
				(written (try! (contract-call? .pyth-lazer-storage write (get records built)))))
			(try! (charge-fee))
			(ok written))))

;;;; Decoded feeds -> storage records

;; Fold the decoded feeds into storage write records. A fold (not `map`) because
;; each record needs the update-level publish-time and channel threaded in, and
;; because missing a required core field must fail the whole update -- the `(err)`
;; accumulator short-circuits the remaining feeds.
(define-private (build-records (decoded {
		timestamp: uint,
		channel: uint,
		price-feeds: (list 16 { feed-id: uint, price: (optional int), exponent: (optional int), confidence: (optional uint) }),
	}))
	(fold add-record (get price-feeds decoded)
		(ok { publish-time: (get timestamp decoded), channel: (get channel decoded), records: (list) })))

(define-private (add-record
		(feed { feed-id: uint, price: (optional int), exponent: (optional int), confidence: (optional uint) })
		(acc (response {
			publish-time: uint,
			channel: uint,
			records: (list 16 {
				feed-id: uint,
				record: {
					price: int, exponent: int, confidence: uint, publish-time: uint, channel: uint,
					ema-price: (optional int), ema-confidence: (optional uint),
					best-bid: (optional int), best-ask: (optional int),
				},
			}),
		} uint)))
	(match acc
		state
			(let ((entry {
					feed-id: (get feed-id feed),
					record: {
						;; ENFORCE the required core fields: a v1 price record is
						;; meaningless without price + exponent + confidence (storage FIXME).
						price: (unwrap! (get price feed) ERR_MISSING_PRICE),
						exponent: (unwrap! (get exponent feed) ERR_MISSING_EXPONENT),
						confidence: (unwrap! (get confidence feed) ERR_MISSING_CONFIDENCE),
						publish-time: (get publish-time state),
						channel: (get channel state),
						ema-price: none,
						ema-confidence: none,
						best-bid: none,
						best-ask: none,
					},
				}))
				;; NOTE: as-max-len? needs a LITERAL bound (u16), not a constant.
				(ok (merge state { records: (unwrap-panic (as-max-len? (append (get records state) entry) u16)) })))
		e (err e)))

;;;; Fee

;; Charge the per-update fee (default u0) from the relayer (tx-sender) to the admin.
;; `stx-transfer?` rejects a zero amount, so guard on it.
(define-private (charge-fee)
	(let ((fee (contract-call? .pyth-lazer-governance get-fee)))
		(if (> fee u0)
			(stx-transfer? fee tx-sender (contract-call? .pyth-lazer-governance get-admin))
			(ok true))))
