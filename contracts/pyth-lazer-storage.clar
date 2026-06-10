;; Title: pyth-lazer-storage
;; Version: v1
;;
;; Durable price store: feed-id (uint) -> price record.
;; IMMUTABLE (PLAN 6.4): holds state only; tuned via the admin-settable
;; `authorized-writer`. It doubles as the stable READ anchor: consumers read
;; here directly, so its address must never move.
;;
;; Phase 3 (this contract):
;;   - `prices` map (feed-id -> generous price record; optionals reserve the
;;     fields the v1 decoder does not populate yet, decision #4 / PLAN 6.4)
;;   - per-feed monotonic publish-time guard (rejects older/equal updates; this
;;     is the self-protecting invariant and the replay defense, PLAN 6.4)
;;   - `get-price` (raw) / `read-price-with-staleness-check` (reads the threshold
;;     from governance and converts microseconds -> seconds, decision #3)
;;   - `write` gated by the admin-settable `authorized-writer` (the active oracle)
;;   - `print` events for chainhook consumers
;;
;; The `write` entry shape is FROZEN by immutability, so it already carries the
;; deferred `(optional ...)` fields: a future decoder-v2 can populate them with
;; no storage redeploy (PLAN 6.4). The v1 oracle passes `none` for those.

;;;; Constants

;; Caller of `write` is not the authorized writer, or a setter caller is not the
;; governance admin.
(define-constant ERR_UNAUTHORIZED (err u3001))
;; `write` called before an authorized writer was configured (bootstrap, PLAN 7).
(define-constant ERR_NO_AUTHORIZED_WRITER (err u3002))
;; No record stored for this feed-id.
(define-constant ERR_PRICE_FEED_NOT_FOUND (err u3003))
;; Stored price is older than the governance staleness window.
(define-constant ERR_STALE_PRICE (err u3004))
;; Could not read wall-clock time from the chain.
(define-constant ERR_NO_BLOCK_TIME (err u3005))
;; A newer-or-equal publish-time is already stored (per-entry; filtered out of a
;; batch rather than failing it).
(define-constant ERR_NEWER_PRICE_AVAILABLE (err u3006))

;; Lazer publish-time is microseconds; staleness compares in seconds (decision #3).
(define-constant MICROS_PER_SECOND u1000000)

;;;; Data vars / maps

;; The single principal allowed to call `write` (the active oracle). `none` until
;; the admin sets it post-deploy: kept out of the constructor so storage does not
;; reference the oracle (which references storage) and create a deploy cycle.
;; Re-pointed to a redeployed oracle via `set-authorized-writer` (PLAN 6.4, 7).
(define-data-var authorized-writer (optional principal) none)

;; feed-id (uint, decision #2) -> generous price record. Core fields (price,
;; exponent, confidence, publish-time, channel) are populated by the v1 decoder;
;; the trailing fields are reserved so this immutable schema never needs a shape
;; change (decision #4 / PLAN 6.4). `publish-time` is microseconds (decision #3);
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

;;;; Read-only API (storage is the stable read anchor; consumers call directly)

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

;; Batch-write up to MAX_FEEDS price records (one Lazer update yields <= 16 feeds).
;; Each entry passes the monotonic guard independently; entries that are not
;; strictly newer than what is stored are skipped (last-write-wins, partial
;; success), mirroring the old bridge. Returns the entries actually written.
(define-public (write (batch (list 16 {
		feed-id: uint,
		price: int,
		exponent: int,
		confidence: uint,
		publish-time: uint,
		channel: uint,
		ema-price: (optional int),
		ema-confidence: (optional uint),
		best-bid: (optional int),
		best-ask: (optional int),
	})))
	(begin
		(asserts! (is-eq contract-caller (unwrap! (var-get authorized-writer) ERR_NO_AUTHORIZED_WRITER)) ERR_UNAUTHORIZED)
		(ok (map unwrap-entry (filter is-ok-entry (map write-entry batch))))))

;; Write one record if its publish-time is strictly newer than the stored one.
;; The map-set (and event) only happen after the guard passes, so a rejected
;; entry leaves storage untouched.
(define-private (write-entry (entry {
		feed-id: uint,
		price: int,
		exponent: int,
		confidence: uint,
		publish-time: uint,
		channel: uint,
		ema-price: (optional int),
		ema-confidence: (optional uint),
		best-bid: (optional int),
		best-ask: (optional int),
	}))
	(let ((feed-id (get feed-id entry))
			(publish-time (get publish-time entry)))
		(asserts! (is-update-newer feed-id publish-time) ERR_NEWER_PRICE_AVAILABLE)
		(map-set prices feed-id {
			price: (get price entry),
			exponent: (get exponent entry),
			confidence: (get confidence entry),
			publish-time: publish-time,
			channel: (get channel entry),
			ema-price: (get ema-price entry),
			ema-confidence: (get ema-confidence entry),
			best-bid: (get best-bid entry),
			best-ask: (get best-ask entry),
		})
		(print { type: "price-feed", action: "updated", data: entry })
		(ok entry)))

;; The replay/monotonic guard: an update is accepted only when its publish-time is
;; strictly newer than the stored one. A feed with no stored record accepts any
;; update. Equal publish-time is rejected (a harmless no-op re-write, PLAN 6.4).
(define-private (is-update-newer (feed-id uint) (publish-time uint))
	(match (map-get? prices feed-id)
		existing (> publish-time (get publish-time existing))
		true))

;;;; Admin (governance admin only -- single admin principal, decision #1)

;; Point storage at the active oracle (the only contract allowed to `write`).
;; Gated by governance's admin so the whole system shares one admin (decision #1).
(define-public (set-authorized-writer (new-writer principal))
	(begin
		(asserts! (is-eq tx-sender (contract-call? .pyth-lazer-governance get-admin)) ERR_UNAUTHORIZED)
		(var-set authorized-writer (some new-writer))
		(print { type: "authorized-writer", action: "updated", data: new-writer })
		(ok true)))

;;;; Fold/filter helpers for the batch write

(define-private (is-ok-entry (entry (response {
		feed-id: uint,
		price: int,
		exponent: int,
		confidence: uint,
		publish-time: uint,
		channel: uint,
		ema-price: (optional int),
		ema-confidence: (optional uint),
		best-bid: (optional int),
		best-ask: (optional int),
	} uint)))
	(is-ok entry))

(define-private (unwrap-entry (entry (response {
		feed-id: uint,
		price: int,
		exponent: int,
		confidence: uint,
		publish-time: uint,
		channel: uint,
		ema-price: (optional int),
		ema-confidence: (optional uint),
		best-bid: (optional int),
		best-ask: (optional int),
	} uint)))
	(unwrap-panic entry))
