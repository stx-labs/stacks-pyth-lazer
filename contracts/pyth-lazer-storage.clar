;; Title: pyth-lazer-storage
;; Version: v1
;;
;; Durable price store: `feed-id (uint) -> price record`, behind a per-feed
;; monotonic publish-time guard (the replay defense, PLAN 6.4) and an admin-
;; settable `authorized-writer`. IMMUTABLE (PLAN 6.4): holds state only. Also the
;; stable READ anchor -- consumers call `get-price` /
;; `read-price-with-staleness-check` here directly -- so its address must never move.

;;;; Constants

;; Caller of `write` is not the authorized writer, or a setter caller is not the
;; governance admin.
(define-constant ERR_UNAUTHORIZED (err u3001))
;; (u3002 retired: writer now has a default, so "no writer configured" is unreachable.)
;; No record stored for this feed-id.
(define-constant ERR_PRICE_FEED_NOT_FOUND (err u3003))
;; Stored price is older than the governance staleness window.
(define-constant ERR_STALE_PRICE (err u3004))
;; Could not read wall-clock time from the chain.
(define-constant ERR_NO_BLOCK_TIME (err u3005))
;; (u3006 retired: a not-newer entry is now skipped silently -- counted as 0
;; writes, never surfaced as an error -- so the monotonic guard needs no code.)

;; Lazer publish-time is microseconds; staleness compares in seconds (decision #3).
(define-constant MICROS_PER_SECOND u1000000)

;;;; Data vars / maps

;; The single principal allowed to call `write` -- the active oracle. Defaults to
;; the v1 oracle so no post-deploy wiring is needed; a principal literal is just an
;; address, so this is not a deploy-order cycle with the oracle (which calls back
;; into storage). Re-point to a redeployed oracle via `set-authorized-writer` (PLAN 6.4, 7).
(define-data-var authorized-writer principal .pyth-lazer-oracle-v1)

;; feed-id (uint, decision #2) -> generous price record. Core fields (price,
;; exponent, confidence, publish-time, channel) are populated by the v1 decoder;
;; the trailing optionals are reserved -- and the `write` entry carries them too --
;; so a later decoder can populate them without reshaping this immutable schema
;; (decision #4 / PLAN 6.4). `publish-time` is microseconds (decision #3);
;; `channel` is recorded, not enforced (PLAN 6.3).
;;
;; FIXME(pre-ship): the optional-vs-required split below is NOT verified against
;; the live Lazer API/SDK. Lazer properties are selected per-subscription (PLAN
;; 3.4), so at the protocol level any property may be absent -- which is why these
;; are `(optional ...)`. BUT if Pyth GUARANTEES a property is always present in our
;; subscription's updates, it must become a REQUIRED field here (drop the optional).
;; Conversely, the "required" core fields above assume price/exponent/confidence are
;; always present -- the oracle must ENFORCE that (reject updates missing them),
;; which is not yet implemented. Confirm the guaranteed property set against a real
;; `evm` fixture and finalize this split before mainnet (PLAN 10 / Phase 5).
;; DO NOT SHIP as-is.
(define-map prices uint {
	price: int,
	exponent: int,
	confidence: uint,
	publish-time: uint,
	channel: uint,
	ema-price: (optional int),
	ema-confidence: (optional uint),
	best-bid: (optional int),
	best-ask: (optional int),
})

;;;; Read-only API

(define-read-only (get-authorized-writer)
	(var-get authorized-writer))

;; Raw read: the stored record, or ERR_PRICE_FEED_NOT_FOUND. No staleness check.
(define-read-only (get-price (feed-id uint))
	(ok (unwrap! (map-get? prices feed-id) ERR_PRICE_FEED_NOT_FOUND)))

;; Read with a freshness guard. Pulls the staleness window (seconds) from
;; governance and compares against wall-clock time, converting the stored
;; microsecond publish-time to seconds (decision #3).
(define-read-only (read-price-with-staleness-check (feed-id uint))
	(let ((entry (unwrap! (map-get? prices feed-id) ERR_PRICE_FEED_NOT_FOUND))
			(threshold (contract-call? .pyth-lazer-governance get-stale-price-threshold))
			(now (unwrap! (get-stacks-block-info? time (- stacks-block-height u1)) ERR_NO_BLOCK_TIME))
			(publish-time-seconds (/ (get publish-time entry) MICROS_PER_SECOND)))
		;; Fresh while `now - publish-time-seconds <= threshold`. Written additively
		;; (`publish + threshold >= now`) so it never underflows a uint.
		(asserts! (>= (+ publish-time-seconds threshold) now) ERR_STALE_PRICE)
		(ok entry)))

;;;; Write API (authorized-writer only)

;; Batch-write up to 16 feeds. Each element is a {feed-id, record} pair stored
;; verbatim under its key. The monotonic guard runs per element, so updates not
;; strictly newer than what is stored are skipped (last-write-wins, partial
;; success). Returns the number of feeds actually written.
(define-public (write (batch (list 16 {
		feed-id: uint,
		record: {
			price: int,
			exponent: int,
			confidence: uint,
			publish-time: uint,
			channel: uint,
			ema-price: (optional int),
			ema-confidence: (optional uint),
			best-bid: (optional int),
			best-ask: (optional int),
		},
	})))
	(begin
		(asserts! (is-eq contract-caller (var-get authorized-writer)) ERR_UNAUTHORIZED)
		(ok (fold write-entry batch u0))))

;; Fold step: write one feed's record and count it, but only if its publish-time
;; is strictly newer than the stored one (the record has no feed-id field -- that
;; is the key). A not-newer entry is skipped, leaving storage and the count
;; untouched, so a batch mixing fresh and stale updates is a partial success.
(define-private (write-entry
		(entry {
			feed-id: uint,
			record: {
				price: int,
				exponent: int,
				confidence: uint,
				publish-time: uint,
				channel: uint,
				ema-price: (optional int),
				ema-confidence: (optional uint),
				best-bid: (optional int),
				best-ask: (optional int),
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
;; strictly newer than the stored one. A feed with no stored record accepts any
;; update. Equal publish-time is rejected (a harmless no-op re-write, PLAN 6.4).
(define-private (is-update-newer (feed-id uint) (publish-time uint))
	(match (map-get? prices feed-id)
		existing (> publish-time (get publish-time existing))
		true))

;;;; Admin (governance admin only -- single admin principal, decision #1)

;; Re-point storage at a redeployed oracle. Gated by governance's admin so the
;; whole system shares one admin (decision #1).
(define-public (set-authorized-writer (new-writer principal))
	(begin
		(asserts! (is-eq tx-sender (contract-call? .pyth-lazer-governance get-admin)) ERR_UNAUTHORIZED)
		(var-set authorized-writer new-writer)
		(print { type: "authorized-writer", action: "updated", data: new-writer })
		(ok true)))
