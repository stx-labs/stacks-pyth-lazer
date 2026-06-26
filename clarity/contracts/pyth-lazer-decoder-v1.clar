;; Title: pyth-lazer-decoder
;; Version: v1
;;
;; Description: Processes raw update messages from Pyth. Has two phases
;;   - Phase 1: Signature verification + trusted-signer check
;;   - Phase 2: Lazer payload/feed parser
;;
;; This contract is stateless, and unlike other Pyth contracts, can be easily updated
;;
;; Currently supports is secp256k1/evm format only, ed25519/solana could be added in future update

;; Implements the swappable decoder interface the oracle dispatches.
(impl-trait .pyth-lazer-traits.decoder-trait)

;;;; Constants

;; -- EVM envelope --
;;   [0:4]   magic (uint32 BE)
;;   [4:36]  signature r
;;   [36:68] signature s
;;   [68]    recovery id (0/1; EVM adds 27 for Solidity, Clarity does not)
;;   [69:71] payload_len (uint16 BE)
;;   [71:]   payload (the signed bytes)
(define-constant EVM_FORMAT_MAGIC u706910618) ;; 0x2a22999a
(define-constant SIG_OFFSET u4)
(define-constant LEN_OFFSET u69)
(define-constant PAYLOAD_OFFSET u71)

;; -- Lazer payload header --
;;   [0:4]   magic (uint32 BE)
;;   [4:12]  timestamp (uint64 BE)
;;   [12]    channel (uint8)
;;   [13]    feeds_len (uint8)
;;   [14:]   feeds (the per-feed records)
(define-constant FORMAT_MAGIC u2479346549) ;; 0x93c7d375
(define-constant PAYLOAD_TIMESTAMP_OFFSET u4)
(define-constant PAYLOAD_CHANNEL_OFFSET u12)
(define-constant PAYLOAD_FEEDS_LEN_OFFSET u13)
(define-constant FEEDS_OFFSET u14)

;; Property type tags the decoder recognizes
;; Other valid types are skipped
;; `ema-*` and `feed-update-timestamp` are not in the v1 subscription, so they are left `none`
(define-constant PROP_PRICE u0)            ;; int64
(define-constant PROP_BEST_BID u1)         ;; int64
(define-constant PROP_BEST_ASK u2)         ;; int64
(define-constant PROP_PUBLISHER_COUNT u3)  ;; uint16
(define-constant PROP_EXPONENT u4)         ;; int16
(define-constant PROP_CONFIDENCE u5)       ;; uint64
(define-constant MAX_PROPERTY_TYPE u12)

;; Max feeds parsed per update. Must match size of `FEED_SLOTS`
(define-constant MAX_FEEDS u16)
(define-constant FEED_SLOTS (list u0 u1 u2 u3 u4 u5 u6 u7 u8 u9 u10 u11 u12 u13 u14 u15))
(define-constant PROPERTY_SLOTS (list u0 u1 u2 u3 u4 u5 u6 u7 u8 u9 u10 u11 u12))

;; Errors: EVM envelope / signature (Phase 1)
(define-constant ERR_INPUT_TOO_SHORT (err u2101))
(define-constant ERR_INVALID_EVM_MAGIC (err u2102))
(define-constant ERR_OVERLAY_PRESENT (err u2103))
(define-constant ERR_INVALID_SIGNATURE (err u2104))
(define-constant ERR_UNTRUSTED_SIGNER (err u2105))

;; Errors: Lazer payload / feeds (Phase 2)
(define-constant ERR_INVALID_PAYLOAD_MAGIC (err u2201))
(define-constant ERR_TOO_MANY_FEEDS (err u2202))
(define-constant ERR_INVALID_FEED_DATA (err u2203)) ;; Truncated / short read while parsing a feed
(define-constant ERR_PAYLOAD_OVERLAY (err u2204))
(define-constant ERR_UNKNOWN_PROPERTY (err u2205))  ;; Property type > MAX_PROPERTY_TYPE
(define-constant ERR_TOO_MANY_PROPS (err u2206))    ;; Feed declares more properties than exist

;;;; Read-only functions

;; Parse EVM envelope and recover payload signer
(define-read-only (recover-signer (update (buff 8192)))
	(let ((update-len (len update)))
		;; Must contain the fixed envelope header
		(asserts! (>= update-len PAYLOAD_OFFSET) ERR_INPUT_TOO_SHORT)
		;; Check magic number
		(asserts! (is-eq (unwrap! (read-uint-be? update u0 u4) ERR_INPUT_TOO_SHORT) EVM_FORMAT_MAGIC) ERR_INVALID_EVM_MAGIC)
		(let ((signature-bytes (unwrap! (slice? update SIG_OFFSET LEN_OFFSET) ERR_INPUT_TOO_SHORT))
				(signature (unwrap! (as-max-len? signature-bytes u65) ERR_INVALID_SIGNATURE))
				(payload-len (unwrap! (read-uint-be? update LEN_OFFSET u2) ERR_INPUT_TOO_SHORT))
				(payload-end (+ PAYLOAD_OFFSET payload-len))
				(payload (unwrap! (slice? update PAYLOAD_OFFSET payload-end) ERR_INPUT_TOO_SHORT)))
			;; Reject trailing bytes past the signed payload
			(asserts! (is-eq update-len payload-end) ERR_OVERLAY_PRESENT)
			;; keccak256(payload) is the signed message hash
			(let ((signer (unwrap! (secp256k1-recover? (keccak256 payload) signature) ERR_INVALID_SIGNATURE)))
				(ok {
					signer: signer,
					payload: payload
				})))))

;; Recover signer and check against trusted signers
(define-read-only (verify-update (update (buff 8192)))
	(let ((recovered (try! (recover-signer update))))
		(asserts! (is-signer-trusted (get signer recovered)) ERR_UNTRUSTED_SIGNER)
		(ok recovered)))

;; Verify signature and parse entire message
(define-read-only (decode-and-verify-price-feeds (update (buff 8192)))
	(let ((verified (try! (verify-update update))))
		(decode-lazer-payload (get payload verified))))

;; Parse Lazer payload
(define-read-only (decode-lazer-payload (payload (buff 8192)))
	(begin
		(asserts! (>= (len payload) FEEDS_OFFSET) ERR_INVALID_FEED_DATA)
		(asserts! (is-eq (unwrap! (read-uint-be? payload u0 u4) ERR_INVALID_PAYLOAD_MAGIC) FORMAT_MAGIC) ERR_INVALID_PAYLOAD_MAGIC)
		(let ((timestamp (unwrap! (read-uint-be? payload PAYLOAD_TIMESTAMP_OFFSET u8) ERR_INVALID_FEED_DATA))
				(channel (unwrap! (read-uint-be? payload PAYLOAD_CHANNEL_OFFSET u1) ERR_INVALID_FEED_DATA))
				(feeds-len (unwrap! (read-uint-be? payload PAYLOAD_FEEDS_LEN_OFFSET u1) ERR_INVALID_FEED_DATA)))
			(asserts! (<= feeds-len MAX_FEEDS) ERR_TOO_MANY_FEEDS)
			(let ((state (try! (fold parse-feed-slot FEED_SLOTS
					(ok {
						bytes: payload,
						offset: FEEDS_OFFSET,
						remaining: feeds-len,
						feeds: (list)
					})))))
				;; Feeds must consume the payload exactly (no trailing overlay)
				(asserts! (is-eq (get offset state) (len payload)) ERR_PAYLOAD_OVERLAY)
				(ok {
					timestamp: timestamp,
					channel: channel,
					price-feeds: (get feeds state)
				})))))

;; Fold step: Parse one feed slot and append to `acc`
;; Feed not appended to `acc` if required field(s) missing
;; On error, `acc` set to `(err ...)` and remaining feeds skipped
(define-private (parse-feed-slot
		(slot_ uint)
		(acc (response {
			bytes: (buff 8192),
			offset: uint,
			remaining: uint,
			feeds: (list 16 {
				feed-id: uint,
				price: int,
				exponent: int,
				confidence: (optional uint),
				publisher-count: uint,
				best-bid: (optional int),
				best-ask: (optional int),
				ema-price: (optional int),
				ema-confidence: (optional uint),
				feed-update-timestamp: (optional uint)
			})
		} uint)))
	(match acc
		state
			(let ((remaining (get remaining state)))
				(if (is-eq remaining u0)
					acc
					(let ((parsed (try! (parse-one-feed (get bytes state) (get offset state))))
							(feed (get feed parsed))
							(feeds (get feeds state))
							;; Keep the feed only if it has all required fields
							(next-feeds (match (get price feed) price
								(match (get exponent feed) exponent
									(match (get publisher-count feed) publisher-count
										;; NOTE: as-max-len? needs a LITERAL bound (u16), not the MAX_FEEDS constant
										(unwrap! (as-max-len? (append feeds (merge feed {
											price: price,
											exponent: exponent,
											publisher-count: publisher-count
										})) u16) ERR_TOO_MANY_FEEDS)
										feeds)
									feeds)
								feeds)))
						(ok (merge state {
							offset: (get offset parsed),
							remaining: (- remaining u1),
							feeds: next-feeds
						})))))
		e (err e)))

;; Parse one feed
;; Returns the feed plus the offset just past it
(define-private (parse-one-feed (bytes (buff 8192)) (offset uint))
	(let ((feed-id (unwrap! (read-uint-be? bytes offset u4) ERR_INVALID_FEED_DATA))
			(num-props (unwrap! (read-uint-be? bytes (+ offset u4) u1) ERR_INVALID_FEED_DATA))
			(parsed (try! (fold parse-property PROPERTY_SLOTS
				(ok {
					bytes: bytes,
					offset: (+ offset u5),
					remaining: num-props,
					price: none,
					exponent: none,
					confidence: none,
					publisher-count: none,
					best-bid: none, best-ask:
					none
				})))))
		;; Every declared property must have been consumed
		(asserts! (is-eq (get remaining parsed) u0) ERR_TOO_MANY_PROPS)
		(ok {
			feed: {
				feed-id: feed-id,
				price: (get price parsed),
				exponent: (get exponent parsed),
				confidence: (get confidence parsed),
				publisher-count: (get publisher-count parsed),
				best-bid: (get best-bid parsed),
				best-ask: (get best-ask parsed),
				;; Reserved fields the v1 subscription does not carry
				ema-price: none,
				ema-confidence: none,
				feed-update-timestamp: none
			},
			offset: (get offset parsed)
		})))

;; Inner fold step: Read the next property's type, save it if recognized, and advance cursor
(define-private (parse-property
		(slot_ uint)
		(acc (response {
			bytes: (buff 8192),
			offset: uint,
			remaining: uint,
			price: (optional int),
			exponent: (optional int),
			confidence: (optional uint),
			publisher-count: (optional uint),
			best-bid: (optional int),
			best-ask: (optional int)
		} uint)))
	(match acc
		state
			;; bytes/off are bound only in the active branch, so no-op tail iterations stay cheap
			(let ((remaining (get remaining state)))
				(if (is-eq remaining u0)
					acc
					(let ((bytes (get bytes state))
							(off (get offset state))
							(ptype (unwrap! (read-uint-be? bytes off u1) ERR_INVALID_FEED_DATA)))
						(asserts! (<= ptype MAX_PROPERTY_TYPE) ERR_UNKNOWN_PROPERTY)
						(let ((advanced (try! (set-property-field ptype bytes (+ off u1) state))))
							(ok (merge advanced {
								offset: (+ off u1 (property-width ptype)),
								remaining: (- remaining u1)
							}))))))
		e (err e)))

;; Lazer's evm encoding has no Option type: A missing optional is encoded as 0, so the
;; reference PythLazerLib treats a parsed 0 (price/bid/ask/confidence/publisher-count) as
;; missing. We mirror that -- collapse 0 to none. Exponent 0 is a real value, kept literally.
(define-private (some-if-nonzero-int (v int)) (if (is-eq v 0) none (some v)))
(define-private (some-if-nonzero-uint (v uint)) (if (is-eq v u0) none (some v)))

;; Extract a property's value into the state
;; Errors on a short read
;; Maps `0` -> `none` as described above
(define-private (set-property-field
		(ptype uint)
		(bytes (buff 8192))
		(voffset uint)
		(state {
			bytes: (buff 8192),
			offset: uint,
			remaining: uint,
			price: (optional int),
			exponent: (optional int),
			confidence: (optional uint),
			publisher-count: (optional uint),
			best-bid: (optional int),
			best-ask: (optional int)
		}))
	(if (is-eq ptype PROP_PRICE)
		(ok (merge state { price: (some-if-nonzero-int (unwrap! (read-int-be? bytes voffset u8) ERR_INVALID_FEED_DATA)) }))
		(if (is-eq ptype PROP_BEST_BID)
			(ok (merge state { best-bid: (some-if-nonzero-int (unwrap! (read-int-be? bytes voffset u8) ERR_INVALID_FEED_DATA)) }))
			(if (is-eq ptype PROP_BEST_ASK)
				(ok (merge state { best-ask: (some-if-nonzero-int (unwrap! (read-int-be? bytes voffset u8) ERR_INVALID_FEED_DATA)) }))
				(if (is-eq ptype PROP_PUBLISHER_COUNT)
					(ok (merge state { publisher-count: (some-if-nonzero-uint (unwrap! (read-uint-be? bytes voffset u2) ERR_INVALID_FEED_DATA)) }))
					(if (is-eq ptype PROP_EXPONENT)
						(ok (merge state { exponent: (some (unwrap! (read-int-be? bytes voffset u2) ERR_INVALID_FEED_DATA)) }))
						(if (is-eq ptype PROP_CONFIDENCE)
							(ok (merge state { confidence: (some-if-nonzero-uint (unwrap! (read-uint-be? bytes voffset u8) ERR_INVALID_FEED_DATA)) }))
							(ok state))))))))

;; Value width (bytes) per property type:
;;   - PublisherCount(u16)/Exponent(i16) -> 2
;;   - MarketSession(u8) -> 1
;;   - Everything else (i64/u64) -> 8
(define-private (property-width (ptype uint))
	(if (or (is-eq ptype u3) (is-eq ptype u4)) u2
		(if (is-eq ptype u9) u1 u8)))

;;;; Trusted-signer check (Phase 1)

;; True if `signer` matches a governance-listed trusted signer that has not expired
(define-private (is-signer-trusted (signer (buff 33)))
	(let ((now (default-to u0 (get-stacks-block-info? time (- stacks-block-height u1)))))
		(get trusted (fold check-trusted-signer
			(contract-call? .pyth-lazer-governance get-trusted-signers)
			{
				target: signer,
				now: now,
				trusted: false
			}))))

(define-private (check-trusted-signer
		(entry {
			pubkey: (buff 33),
			expires-at: uint
		})
		(acc {
			target: (buff 33),
			now: uint,
			trusted: bool
		}))
	(if (and (is-eq (get pubkey entry) (get target acc))
			(< (get now acc) (get expires-at entry)))
		(merge acc { trusted: true })
		acc))

;;;; Helper functions: Buffer reading

;; #[allow(case_fn)]
(define-private (read-uint-be? (bytes (buff 8192)) (pos uint) (size uint))
	(match (slice? bytes pos (+ pos size))
		b (some (buff-to-uint-be (unwrap! (as-max-len? b u16) none)))
		none))

;; #[allow(case_fn)]
(define-private (read-int-be? (bytes (buff 8192)) (pos uint) (size uint))
	(match (slice? bytes pos (+ pos size))
		b (let ((shift (* (- u16 size) u8)))
			;; Sign-extend an N-byte two's-complement value: shift the sign bit to bit 127 and back.
			(some (bit-shift-right (bit-shift-left (buff-to-int-be (unwrap! (as-max-len? b u16) none)) shift) shift)))
		none))
