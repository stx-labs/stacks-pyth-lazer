;; Title: pyth-lazer-decoder
;; Version: v1
;;
;; SWAPPABLE (PLAN 6.4): the only volatile contract. Owns the security-critical
;; path: EVM-envelope parse, secp256k1 signature recovery, trusted-signer
;; validation (reads governance), and Lazer payload parse. The oracle receives
;; this as a trait param and validates it against governance's blessed decoder.
;;
;; Phase 1: signature verification (PLAN 3.2) + trusted-signer check.
;; Phase 2: Lazer payload/feed parser (PLAN 3.3-3.4), composed by
;;   `decode-and-verify-price-feeds`. Byte order follows the EVM PythLazerLib
;;   (big-endian), confirmed against real upstream + production `evm` fixtures
;;   (golden tests + tests/fixtures/captured).
;;
;; CLARITY6 (SIP-43): `ed25519-verify` would add Lazer's `solana` (ed25519) format;
;;   `secp256k1-decompress?` would let signers be keyed by ETH address. v1 is
;;   secp256k1/`evm`-only, keyed by compressed pubkey (PLAN 3.1, 3.5, 4.1).

;; Implements the swappable decoder interface the oracle dispatches (PLAN 6.4).
(impl-trait .pyth-lazer-traits.decoder-trait)

;;;; Constants

;; -- EVM envelope (PLAN 3.2) --
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

;; -- Lazer payload header (PLAN 3.3): magic(4) timestamp(8) channel(1) feedsLen(1) --
(define-constant FORMAT_MAGIC u2479346549) ;; 0x93c7d375
(define-constant PAYLOAD_TIMESTAMP_OFFSET u4)
(define-constant PAYLOAD_CHANNEL_OFFSET u12)
(define-constant PAYLOAD_FEEDS_LEN_OFFSET u13)
(define-constant FEEDS_OFFSET u14)

;; Property type tags the v1 decoder persists (PLAN decision #4). Other valid types
;; are skipped (the cursor still advances by their width). The ema-* and
;; feed-update-timestamp storage fields are NOT in the v1 subscription, so they are
;; left `none` here; a later decoder can populate them (PLAN 6.4).
(define-constant PROP_PRICE u0)            ;; int64
(define-constant PROP_BEST_BID u1)         ;; int64
(define-constant PROP_BEST_ASK u2)         ;; int64
(define-constant PROP_PUBLISHER_COUNT u3)  ;; uint16
(define-constant PROP_EXPONENT u4)         ;; int16
(define-constant PROP_CONFIDENCE u5)       ;; uint64
(define-constant MAX_PROPERTY_TYPE u12)

;; Max feeds parsed per update; updates declaring more are rejected. Bump by
;; extending FEED_SLOTS and the (list 16 ...) types below.
(define-constant MAX_FEEDS u16)
(define-constant FEED_SLOTS (list u0 u1 u2 u3 u4 u5 u6 u7 u8 u9 u10 u11 u12 u13 u14 u15))
(define-constant PROPERTY_SLOTS (list u0 u1 u2 u3 u4 u5 u6 u7 u8 u9 u10 u11 u12))

;; Errors -- envelope / signature (Phase 1)
(define-constant ERR_INPUT_TOO_SHORT (err u2101))
(define-constant ERR_INVALID_EVM_MAGIC (err u2102))
(define-constant ERR_OVERLAY_PRESENT (err u2103))
(define-constant ERR_INVALID_SIGNATURE (err u2104))
(define-constant ERR_UNTRUSTED_SIGNER (err u2105))

;; Errors -- payload / feeds (Phase 2). The parsing folds carry their accumulator
;; as a (response state uint): `(ok state)` while parsing, `(err ...)` once a step
;; fails. That lets the fold callbacks and their helpers use try!/unwrap!/asserts!
;; directly, and decode-payload surface the failure with a plain try!.
(define-constant ERR_INVALID_PAYLOAD_MAGIC (err u2201))
(define-constant ERR_TOO_MANY_FEEDS (err u2202))
(define-constant ERR_INVALID_FEED_DATA (err u2203)) ;; truncated / short read while parsing a feed
(define-constant ERR_PAYLOAD_OVERLAY (err u2204))
(define-constant ERR_UNKNOWN_PROPERTY (err u2205))  ;; property type > MAX_PROPERTY_TYPE
(define-constant ERR_TOO_MANY_PROPS (err u2206))    ;; feed declares more properties than exist

;;;; Verification + decode entry points
;; (`recover-signer` / `verify-update` are read-only; `decode-and-verify-price-feeds`
;; is public so it can back the decoder-trait -- see its comment.)

;; Parse the EVM envelope and recover the signer of the payload.
;; Performs no trust check (see `verify-update`).
;; Returns the recovered 33-byte compressed secp256k1 pubkey and the signed payload.
(define-read-only (recover-signer (update (buff 8192)))
	(let ((update-len (len update)))
		;; Must at least contain the fixed envelope header
		(asserts! (>= update-len PAYLOAD_OFFSET) ERR_INPUT_TOO_SHORT)
		;; Check the EVM format magic
		(asserts! (is-eq (unwrap! (read-uint-be? update u0 u4) ERR_INPUT_TOO_SHORT) EVM_FORMAT_MAGIC) ERR_INVALID_EVM_MAGIC)
		(let ((signature-bytes (unwrap! (slice? update SIG_OFFSET LEN_OFFSET) ERR_INPUT_TOO_SHORT))
				(signature (unwrap! (as-max-len? signature-bytes u65) ERR_INVALID_SIGNATURE))
				(payload-len (unwrap! (read-uint-be? update LEN_OFFSET u2) ERR_INPUT_TOO_SHORT))
				(payload-end (+ PAYLOAD_OFFSET payload-len))
				(payload (unwrap! (slice? update PAYLOAD_OFFSET payload-end) ERR_INPUT_TOO_SHORT)))
			;; The signed payload must be exactly the tail of the update: reject any
			;; trailing overlay bytes (not covered by the signature).
			(asserts! (is-eq update-len payload-end) ERR_OVERLAY_PRESENT)
			;; keccak256(payload) is the signed message hash; recover the compressed pubkey.
			(let ((signer (unwrap! (secp256k1-recover? (keccak256 payload) signature) ERR_INVALID_SIGNATURE)))
				(ok {
					signer: signer,
					payload: payload
				})))))

;; Recover the signer and assert it is a trusted, non-expired Lazer signer.
;; Trust DATA comes from governance; the membership + expiry LOGIC lives here
;; (PLAN 6.4). Returns the verified signer and payload.
(define-read-only (verify-update (update (buff 8192)))
	(let ((recovered (try! (recover-signer update))))
		(asserts! (is-signer-trusted (get signer recovered)) ERR_UNTRUSTED_SIGNER)
		(ok recovered)))

;; Verify the signature/signer, then parse the Lazer payload into price feeds.
;; Returns the update timestamp (microseconds), channel, and per-feed records.
;; PUBLIC (not read-only) so it satisfies `decoder-trait` for the oracle's dynamic
;; dispatch -- Clarity trait methods cannot be read-only. It is still pure (no
;; state writes), so off-chain callers can invoke it read-only.
(define-public (decode-and-verify-price-feeds (update (buff 8192)))
	(let ((verified (try! (verify-update update))))
		(decode-payload (get payload verified))))

;;;; Payload parsing (Phase 2)

;; Parse a verified Lazer payload: header + sequential feeds. Each feed lists a
;; subset of properties (TLV: type byte + type-width value); we persist
;; price/exponent/confidence/publisher-count/best-bid/best-ask and skip the rest.
;; A final exact-length check guarantees every property width was honored.
(define-read-only (decode-payload (payload (buff 8192)))
	(begin
		(asserts! (>= (len payload) FEEDS_OFFSET) ERR_INVALID_FEED_DATA)
		(asserts! (is-eq (unwrap! (read-uint-be? payload u0 u4) ERR_INVALID_PAYLOAD_MAGIC) FORMAT_MAGIC) ERR_INVALID_PAYLOAD_MAGIC)
		(let ((timestamp (unwrap! (read-uint-be? payload PAYLOAD_TIMESTAMP_OFFSET u8) ERR_INVALID_FEED_DATA))
				(channel (unwrap! (read-uint-be? payload PAYLOAD_CHANNEL_OFFSET u1) ERR_INVALID_FEED_DATA))
				(feeds-len (unwrap! (read-uint-be? payload PAYLOAD_FEEDS_LEN_OFFSET u1) ERR_INVALID_FEED_DATA)))
			(asserts! (<= feeds-len MAX_FEEDS) ERR_TOO_MANY_FEEDS)
			;; `try!` surfaces the specific parse error the fold recorded, if any.
			(let ((state (try! (fold parse-feed-slot FEED_SLOTS
					(ok { bytes: payload, offset: FEEDS_OFFSET, remaining: feeds-len, feeds: (list) })))))
				;; The feeds must consume the payload exactly (no trailing overlay).
				(asserts! (is-eq (get offset state) (len payload)) ERR_PAYLOAD_OVERLAY)
				(ok {
					timestamp: timestamp,
					channel: channel,
					price-feeds: (get feeds state)
				})))))

;; One outer-fold step. The accumulator is `(response state uint)`: pass through
;; once errored (`e (err e)`) or once all declared feeds are parsed (remaining 0);
;; otherwise parse the next feed at the cursor and append it.
(define-private (parse-feed-slot
		(slot uint)
		(acc (response { bytes: (buff 8192), offset: uint, remaining: uint,
			feeds: (list 16 { feed-id: uint, price: (optional int), exponent: (optional int),
				confidence: (optional uint), publisher-count: (optional uint),
				best-bid: (optional int), best-ask: (optional int), ema-price: (optional int),
				ema-confidence: (optional uint), feed-update-timestamp: (optional uint) }) } uint)))
	(match acc
		state
			(let ((remaining (get remaining state))) ;; read on both the guard and the decrement
				(if (is-eq remaining u0)
					acc
					(let ((parsed (try! (parse-one-feed (get bytes state) (get offset state)))))
						(ok (merge state {
							offset: (get offset parsed),
							remaining: (- remaining u1),
							;; NOTE: as-max-len? needs a LITERAL bound (u16), not the MAX_FEEDS constant.
							feeds: (unwrap-panic (as-max-len? (append (get feeds state) (get feed parsed)) u16)) })))))
		e (err e)))

;; Parse one feed (feed-id, num-properties, then its properties). Returns the
;; assembled record plus the offset immediately after the feed.
(define-private (parse-one-feed (bytes (buff 8192)) (offset uint))
	(let ((feed-id (unwrap! (read-uint-be? bytes offset u4) ERR_INVALID_FEED_DATA))
			(num-props (unwrap! (read-uint-be? bytes (+ offset u4) u1) ERR_INVALID_FEED_DATA))
			(parsed (try! (fold parse-property PROPERTY_SLOTS
				(ok { bytes: bytes, offset: (+ offset u5), remaining: num-props,
					price: none, exponent: none, confidence: none,
					publisher-count: none, best-bid: none, best-ask: none })))))
		;; Every declared property must have been consumed (num-props <= PROPERTY_SLOTS).
		(asserts! (is-eq (get remaining parsed) u0) ERR_TOO_MANY_PROPS)
		(ok {
			feed: { feed-id: feed-id, price: (get price parsed),
				exponent: (get exponent parsed), confidence: (get confidence parsed),
				publisher-count: (get publisher-count parsed), best-bid: (get best-bid parsed),
				best-ask: (get best-ask parsed),
				;; Reserved storage fields the v1 subscription does not carry (PLAN 6.4).
				ema-price: none, ema-confidence: none, feed-update-timestamp: none },
			offset: (get offset parsed)
		})))

;; One inner-fold step. Like parse-feed-slot, the accumulator is a response: read
;; the next property's type, persist it if relevant, and advance the cursor by
;; 1 (type byte) + the property's value width.
(define-private (parse-property
		(slot uint)
		(acc (response { bytes: (buff 8192), offset: uint, remaining: uint,
			price: (optional int), exponent: (optional int), confidence: (optional uint),
			publisher-count: (optional uint), best-bid: (optional int), best-ask: (optional int) } uint)))
	(match acc
		state
			;; `remaining` is read on both the guard and the decrement; bind it once.
			;; `bytes`/`off` are bound only inside the active branch, so the no-op tail
			;; iterations (remaining = 0) never pay to extract the payload buffer.
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
								remaining: (- remaining u1) }))))))
		e (err e)))

;; Lazer's `evm` encoding has no Option type, so the reference PythLazerLib
;; (pyth-crosschain lazer/contracts/evm v0.1.1) encodes a MISSING optional as the
;; value 0: it treats a parsed 0 for Price/BestBid/BestAsk/Confidence/PublisherCount
;; as ApplicableButMissing rather than Present (Exponent is the lone field it always
;; marks Present). We mirror that here -- collapse a 0 to `none` for those fields --
;; so our `(optional ...)` matches the protocol's intent and the SDK's parsed JSON.
;; A 0 exponent is a real value, so exponent is stored literally.
(define-private (some-if-nonzero-int (v int)) (if (is-eq v 0) none (some v)))
(define-private (some-if-nonzero-uint (v uint)) (if (is-eq v u0) none (some v)))

;; Extract the value of a persisted property into the state; pass through
;; (advance only) for properties we don't persist. Errors on a short read.
;; Optional fields collapse a 0 value to `none` (the Lazer "missing" sentinel,
;; see above); exponent is stored literally.
(define-private (set-property-field
		(ptype uint) (bytes (buff 8192)) (voffset uint)
		(state { bytes: (buff 8192), offset: uint, remaining: uint,
			price: (optional int), exponent: (optional int), confidence: (optional uint),
			publisher-count: (optional uint), best-bid: (optional int), best-ask: (optional int) }))
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

;; Value width (bytes) per property type (PLAN 3.4 / PythLazerStructs):
;;   3 PublisherCount(u16), 4 Exponent(i16) -> 2 ; 9 MarketSession(u8) -> 1 ;
;;   everything else (price/bid/ask/conf/funding/ema/timestamps, i64/u64) -> 8.
(define-private (property-width (ptype uint))
	(if (or (is-eq ptype u3) (is-eq ptype u4)) u2
		(if (is-eq ptype u9) u1 u8)))

;;;; Trusted-signer check (Phase 1)

;; True if `signer` matches a governance-listed trusted signer that has not expired.
(define-private (is-signer-trusted (signer (buff 33)))
	(let ((now (default-to u0 (get-stacks-block-info? time (- stacks-block-height u1)))))
		(get trusted (fold check-trusted-signer
			(contract-call? .pyth-lazer-governance get-trusted-signers)
			{ target: signer, now: now, trusted: false }))))

(define-private (check-trusted-signer
		(entry { pubkey: (buff 33), expires-at: uint })
		(acc { target: (buff 33), now: uint, trusted: bool }))
	(if (and (is-eq (get pubkey entry) (get target acc))
			(< (get now acc) (get expires-at entry)))
		(merge acc { trusted: true })
		acc))

;;;; Byte readers (big-endian; sizes <= 16). Optional-returning so callers can
;;;; `unwrap!` with a contextual error.

(define-private (read-uint-be? (bytes (buff 8192)) (pos uint) (size uint))
	(match (slice? bytes pos (+ pos size))
		b (some (buff-to-uint-be (unwrap-panic (as-max-len? b u16))))
		none))

;; Sign-extend an N-byte two's-complement value: shift the sign bit to position
;; 127 and back. Works regardless of buff-to-int-be's extension behavior.
(define-private (read-int-be? (bytes (buff 8192)) (pos uint) (size uint))
	(match (slice? bytes pos (+ pos size))
		b (let ((shift (* (- u16 size) u8)))
			(some (bit-shift-right (bit-shift-left (buff-to-int-be (unwrap-panic (as-max-len? b u16))) shift) shift)))
		none))
