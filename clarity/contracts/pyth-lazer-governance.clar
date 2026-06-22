;; Title: pyth-lazer-governance
;; Version: v1
;;
;; Config state for the oracle. IMMUTABLE (PLAN 6.4): holds the trust policy as
;; DATA only; the validation LOGIC (membership + expiry) lives in the swappable
;; decoder, which is what makes immutability safe.
;;
;; Access control is role-based (mirrors stx-labs/usdcx-token): a {who, role} -> bool
;; map of grants, not a single owner. Two roles -- `governance` (manage signers, fee,
;; decoder, stale threshold, the authorized writer, and role grants) and `pause` (halt
;; and resume the protocol). The deployer is granted both at deploy; either can be
;; reassigned to a multisig/DAO or a dedicated pause key, and revoked, via set-role.
;; Roles are opaque 1-byte IDs (NOT bitflags): 0x00 is a valid id, and each grant is an
;; independent entry, so granting one role can never disturb another.
;;
;; Future hardening (rough order of effort): hold roles in a multisig principal (no code
;; change); finer-grained roles (signer-manager vs fee-setter vs upgrader); a timelock on
;; sensitive changes; Lazer-signed governance messages from Pyth.

;; The decoder interface, imported so `set-decoder` can take a `<decoder-trait>` and
;; reject a non-conforming principal at the type level (see set-decoder).
(use-trait decoder-trait .pyth-lazer-traits.decoder-trait)

;;;; Constants

;; Caller lacks the required role.
(define-constant ERR_UNAUTHORIZED (err u4003))
;; Protocol is paused.
(define-constant ERR_PAUSED (err u4004))

;; Role IDs: opaque 1-byte discriminators (NOT bitflags), used as map keys.
(define-constant ROLE_GOVERNANCE 0x00) ;; manage signers/fee/decoder/threshold/writer + roles
(define-constant ROLE_PAUSE      0x01) ;; pause / unpause

;;;; Data vars / maps

;; Role grants: a (principal, role) pair maps to true while held; absent means not held.
(define-map roles { who: principal, role: (buff 1) } bool)

;; Bootstrap: the deployer holds both roles at deploy. Reassign/revoke via set-role.
(map-set roles { who: tx-sender, role: ROLE_GOVERNANCE } true)
(map-set roles { who: tx-sender, role: ROLE_PAUSE } true)

;; Pause switch. While true, the oracle update path and every governance config change
;; are blocked; only pause/unpause themselves still run (so the pauser can recover).
(define-data-var paused bool false)

;; Trusted Lazer signers: compressed secp256k1 pubkeys, each with an expiry
;; (unix seconds). A signature is valid only while `now < expires-at` (PLAN 3.5).
;; The decoder reads this list and applies the membership + expiry check.
(define-data-var trusted-signers
	(list 16 { pubkey: (buff 33), expires-at: uint })
	(list))

;; Stale-price threshold, in SECONDS, read by `pyth-lazer-storage` for its read-side
;; freshness check (storage converts Lazer's microsecond publish-time, decision #3).
;; Defaults are deliberately loose so simnet/testnet reads never go stale until an
;; admin tightens them.
(define-data-var stale-price-threshold uint
	(if is-in-mainnet u7200 u157680000)) ;; 2h (2*60*60) mainnet / ~5y (5*365*24*60*60) else

;; Blessed decoder: the principal the oracle accepts as its `<decoder>` trait param
;; (PLAN 6.4). Defaults to the v1 decoder so no post-deploy wiring is needed -- a
;; principal literal is just an address, so this is not a deploy-order dependency on
;; the decoder (which calls back into governance). Re-point to a decoder-v2 to upgrade.
(define-data-var decoder principal .pyth-lazer-decoder-v1)

;; Per-update fee in microSTX, charged by the oracle to the relayer (decision #6).
;; Default u0 (no fee). The oracle routes it to `fee-recipient`.
(define-data-var fee uint u0)

;; Where the oracle sends collected fees. Defaults to the deployer; governance-settable
;; (there is no longer a single "admin" principal to fall back on).
(define-data-var fee-recipient principal tx-sender)

;;;; Read-only getters

(define-read-only (get-trusted-signers)
	(var-get trusted-signers))

(define-read-only (get-stale-price-threshold)
	(var-get stale-price-threshold))

(define-read-only (get-decoder)
	(var-get decoder))

(define-read-only (get-fee)
	(var-get fee))

(define-read-only (get-fee-recipient)
	(var-get fee-recipient))

;; Does `who` currently hold `role`?
(define-read-only (has-role (who principal) (role (buff 1)))
	(default-to false (map-get? roles { who: who, role: role })))

(define-read-only (is-paused)
	(var-get paused))

;;;; Guards
;;
;; Read-only so the oracle and storage can `try!` them across a contract-call. Callers
;; pass the principal to check rather than relying on this contract's `contract-caller`:
;; a governance setter passes its own `contract-caller` (the direct caller); a cross-
;; contract caller passes the principal it gates on. We always gate on `contract-caller`,
;; never `tx-sender` -- a `tx-sender` gate would pass if a role-holder were phished into
;; calling a malicious wrapper (the tx.origin pattern). A contract can hold a role.

;; Assert `who` holds `role`.
(define-read-only (assert-role (who principal) (role (buff 1)))
	(ok (asserts! (has-role who role) ERR_UNAUTHORIZED)))

;; Assert `who` holds the governance role -- the common cross-contract check, so callers
;; need not hardcode the role byte.
(define-read-only (assert-governance (who principal))
	(assert-role who ROLE_GOVERNANCE))

;; Assert the protocol is not paused.
(define-read-only (assert-active)
	(ok (asserts! (not (var-get paused)) ERR_PAUSED)))

;;;; Governance functions
;;
;; Each requires the governance role AND that the protocol is active (blocked while
;; paused, matching usdcx-token; the pauser must unpause first).

;; Replace the full trusted-signer set (pass the new full list to add or remove).
;; A per-signer setter (expires-at = u0 to remove) is a future nicety (PLAN 7).
(define-public (set-trusted-signers
		(signers (list 16 { pubkey: (buff 33), expires-at: uint })))
	(begin
		(try! (assert-active))
		(try! (assert-governance contract-caller))
		(var-set trusted-signers signers)
		(print { type: "trusted-signers", action: "updated", data: { signers: signers } })
		(ok true)))

;; Override the staleness window (seconds). Section 7: occasional admin tuning.
(define-public (set-stale-price-threshold (seconds uint))
	(begin
		(try! (assert-active))
		(try! (assert-governance contract-caller))
		(var-set stale-price-threshold seconds)
		(print { type: "stale-price-threshold", action: "updated", data: { seconds: seconds } })
		(ok true)))

;; Bless a new decoder the oracle will accept (PLAN 6.4); call this to upgrade to a
;; decoder-v2. Takes a `<decoder-trait>` (not a bare principal) so the type system
;; rejects blessing a non-decoder, which would otherwise brick the oracle. Stores
;; `(contract-of new-decoder)`; the oracle compares the passed decoder against it.
(define-public (set-decoder (new-decoder <decoder-trait>))
	(begin
		(try! (assert-active))
		(try! (assert-governance contract-caller))
		(let ((new-principal (contract-of new-decoder)))
			(var-set decoder new-principal)
			(print { type: "decoder", action: "updated", data: { new-decoder: new-principal } })
			(ok true))))

;; Set the per-update fee (microSTX). Section 7: occasional admin tuning.
(define-public (set-fee (new-fee uint))
	(begin
		(try! (assert-active))
		(try! (assert-governance contract-caller))
		(var-set fee new-fee)
		(print { type: "fee", action: "updated", data: { new-fee: new-fee } })
		(ok true)))

;; Set the principal that receives collected fees.
(define-public (set-fee-recipient (new-recipient principal))
	(begin
		(try! (assert-active))
		(try! (assert-governance contract-caller))
		(var-set fee-recipient new-recipient)
		(print { type: "fee-recipient", action: "updated", data: { new-recipient: new-recipient } })
		(ok true)))

;; Grant (enabled true) or revoke (false) a role for a principal. Each (who, role) grant
;; is independent, so this never disturbs another role the principal holds.
(define-public (set-role (who principal) (role (buff 1)) (enabled bool))
	(begin
		(try! (assert-active))
		(try! (assert-governance contract-caller))
		(if enabled
			(map-set roles { who: who, role: role } true)
			(map-delete roles { who: who, role: role }))
		(print { type: "role", action: "updated", data: { who: who, role: role, enabled: enabled } })
		(ok true)))

;;;; Pause functions
;;
;; Require the pause role only -- deliberately NOT gated on `assert-active`, so the pauser
;; can always unpause (and pausing twice is a harmless no-op).

(define-public (pause)
	(begin
		(try! (assert-role contract-caller ROLE_PAUSE))
		(var-set paused true)
		(print { type: "pause", action: "paused", data: { caller: contract-caller } })
		(ok true)))

(define-public (unpause)
	(begin
		(try! (assert-role contract-caller ROLE_PAUSE))
		(var-set paused false)
		(print { type: "pause", action: "unpaused", data: { caller: contract-caller } })
		(ok true)))
