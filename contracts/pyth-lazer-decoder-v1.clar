;; Title: pyth-lazer-decoder
;; Version: v1 (Phase 0 scaffold)
;;
;; SWAPPABLE (PLAN 6.4): the only volatile contract. Owns the security-critical
;; path: EVM-envelope parse, secp256k1 signature recovery, trusted-signer
;; validation (reads governance), and Lazer payload parse. The oracle receives
;; this as a trait param and validates it against governance's blessed decoder.
;;
;; Phase 1 wires signature verification (PLAN 3.2); Phase 2 the payload/feed
;; parser (PLAN 3.3-3.4). The byte-reader helpers below are ported now (Phase 0)
;; and consumed by those phases.
;;
;; CLARITY6 (SIP-43): `ed25519-verify` would let this decoder also accept Lazer's
;;   `solana` (ed25519) format; v1 is secp256k1/`evm`-only (PLAN 3.1, 4.1).
;; CLARITY6 (SIP-43): `secp256k1-decompress?` would let us key trusted signers by
;;   ETH address; v1 uses compressed-pubkey identity instead (PLAN 3.5, 4.1).
;; CLARITY6 (SIP-43): variadic `concat` would flatten any multi-part buffer
;;   assembly - minor here, the decoder is slice/parse-dominant (PLAN 4.1).

;; ---------------------------------------------------------------------------
;; Byte-reader helpers - ported from stacks-pyth-bridge (PLAN Phase 0).
;; Shared parsing primitives for the EVM envelope (3.2) and Lazer payload
;; (3.3-3.4). All multi-byte integers in the Lazer wire format are big-endian.
;; Wired into the parser in Phase 1/2 (currently unused by design).
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
