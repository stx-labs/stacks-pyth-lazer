;; Title: pyth-lazer-decoder
;; Version: v1
;;
;; SWAPPABLE (PLAN 6.4): the only volatile contract. Owns the security-critical
;; path: EVM-envelope parse, secp256k1 signature recovery, trusted-signer
;; validation (reads governance), and Lazer payload parse. The oracle receives
;; this as a trait param and validates it against governance's blessed decoder.
;;
;; Phase 1 (DONE): signature verification (PLAN 3.2) + trusted-signer check.
;; Phase 2 (TODO): Lazer payload/feed parser (PLAN 3.3-3.4) -> price records,
;;   then `decode-and-verify-price-feeds` (the public trait method) composes
;;   `verify-update` + the parser.
;;
;; CLARITY6 (SIP-43): `ed25519-verify` would let this decoder also accept Lazer's
;;   `solana` (ed25519) format; v1 is secp256k1/`evm`-only (PLAN 3.1, 4.1).
;; CLARITY6 (SIP-43): `secp256k1-decompress?` would let us key trusted signers by
;;   ETH address; v1 uses compressed-pubkey identity instead (PLAN 3.5, 4.1).
;; CLARITY6 (SIP-43): variadic `concat` would flatten any multi-part buffer
;;   assembly - minor here, the decoder is slice/parse-dominant (PLAN 4.1).

;;;; Constants

;; EVM-format envelope magic (PLAN 3.2): bytes [0:4], uint32 BE = 0x2a22999a.
(define-constant EVM_FORMAT_MAGIC u706910618)

;; EVM envelope field offsets (PLAN 3.2):
;;   [0:4]  magic | [4:36] r | [36:68] s | [68] recovery id (0/1) | [69:71] payload_len | [71:] payload
;; The 65-byte signature for `secp256k1-recover?` is the contiguous slice [4:69]
;; (r || s || recovery-id). The wire recovery byte is already 0/1 - EVM adds 27
;; only for Solidity's ecrecover, which Clarity does NOT want.
(define-constant SIG_OFFSET u4)
(define-constant LEN_OFFSET u69)
(define-constant PAYLOAD_OFFSET u71)

;; Input shorter than the fixed 71-byte envelope header (or than declared payload)
(define-constant ERR_INPUT_TOO_SHORT (err u2101))
;; Leading magic bytes are not the EVM format magic
(define-constant ERR_INVALID_EVM_MAGIC (err u2102))
;; Trailing bytes present after the signed payload (malleability guard)
(define-constant ERR_OVERLAY_PRESENT (err u2103))
;; secp256k1 recovery failed (malformed signature)
(define-constant ERR_INVALID_SIGNATURE (err u2104))
;; Recovered signer is not a trusted Lazer signer (or its key has expired)
(define-constant ERR_UNTRUSTED_SIGNER (err u2105))

;;;; Public (read-only) functions

;; Parse the EVM envelope and recover the signer of the payload. PURE: performs
;; no trust check (see `verify-update`). Returns the recovered 33-byte compressed
;; secp256k1 pubkey and the signed payload.
(define-read-only (recover-signer (update (buff 8192)))
	(let ((update-len (len update)))
		;; Must at least contain the fixed envelope header
		(asserts! (>= update-len PAYLOAD_OFFSET) ERR_INPUT_TOO_SHORT)
		;; Check the EVM format magic
		(asserts! (is-eq (try! (read-uint-32 update u0)) EVM_FORMAT_MAGIC) ERR_INVALID_EVM_MAGIC)
		(let ((signature (unwrap! (as-max-len? (unwrap! (slice? update SIG_OFFSET LEN_OFFSET) ERR_INPUT_TOO_SHORT) u65) ERR_INVALID_SIGNATURE))
				(payload-len (try! (read-uint-16 update LEN_OFFSET)))
				(payload-end (+ PAYLOAD_OFFSET payload-len))
				(payload (unwrap! (slice? update PAYLOAD_OFFSET payload-end) ERR_INPUT_TOO_SHORT)))
			;; The signed payload must be exactly the tail of the update: reject any
			;; trailing overlay bytes (not covered by the signature).
			(asserts! (is-eq update-len payload-end) ERR_OVERLAY_PRESENT)
			;; keccak256(payload) is the signed message hash; recover the compressed pubkey.
			(let ((signer (unwrap! (secp256k1-recover? (keccak256 payload) signature) ERR_INVALID_SIGNATURE)))
				(ok { signer: signer, payload: payload })))))

;; Recover the signer and assert it is a trusted, non-expired Lazer signer.
;; Trust DATA comes from governance; the membership + expiry LOGIC lives here
;; (PLAN 6.4). Returns the verified signer and payload.
(define-read-only (verify-update (update (buff 8192)))
	(let ((recovered (try! (recover-signer update))))
		(asserts! (is-signer-trusted (get signer recovered)) ERR_UNTRUSTED_SIGNER)
		(ok recovered)))

;;;; Private functions

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

;; ---------------------------------------------------------------------------
;; Byte-reader helpers - ported from stacks-pyth-bridge (PLAN Phase 0).
;; Shared parsing primitives for the EVM envelope (3.2) and Lazer payload
;; (3.3-3.4). All multi-byte integers in the Lazer wire format are big-endian.
;; `read-uint-8` / `read-uint-64` / `read-int-*` are consumed by the Phase 2 parser.
;; ---------------------------------------------------------------------------

(define-private (read-buff (bytes (buff 8192)) (pos uint) (length uint))
	(ok (unwrap! (slice? bytes pos (+ pos length)) (err u1))))

(define-private (read-uint-8 (bytes (buff 8192)) (pos uint))
	(ok (buff-to-uint-be (unwrap-panic (as-max-len? (try! (read-buff bytes pos u1)) u1)))))

(define-private (read-uint-16 (bytes (buff 8192)) (pos uint))
	(ok (buff-to-uint-be (unwrap-panic (as-max-len? (try! (read-buff bytes pos u2)) u2)))))

(define-private (read-uint-32 (bytes (buff 8192)) (pos uint))
	(ok (buff-to-uint-be (unwrap-panic (as-max-len? (try! (read-buff bytes pos u4)) u4)))))

(define-private (read-uint-64 (bytes (buff 8192)) (pos uint))
	(ok (buff-to-uint-be (unwrap-panic (as-max-len? (try! (read-buff bytes pos u8)) u8)))))

;; Signed readers sign-extend an N-byte two's-complement value into a 128-bit int
;; by shifting the sign bit to position 127 and back (arithmetic shift).
(define-private (read-int-16 (bytes (buff 8192)) (pos uint))
	(ok (bit-shift-right (bit-shift-left (buff-to-int-be (unwrap-panic (as-max-len? (try! (read-buff bytes pos u2)) u2))) u112) u112)))

(define-private (read-int-32 (bytes (buff 8192)) (pos uint))
	(ok (bit-shift-right (bit-shift-left (buff-to-int-be (unwrap-panic (as-max-len? (try! (read-buff bytes pos u4)) u4))) u96) u96)))

(define-private (read-int-64 (bytes (buff 8192)) (pos uint))
	(ok (bit-shift-right (bit-shift-left (buff-to-int-be (unwrap-panic (as-max-len? (try! (read-buff bytes pos u8)) u8))) u64) u64)))
