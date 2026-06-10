;; Title: pyth-lazer-governance
;; Version: v1
;;
;; Config state for the oracle. IMMUTABLE (PLAN 6.4): holds the trust policy as
;; DATA only; the validation LOGIC (membership + expiry) lives in the swappable
;; decoder, which is what makes immutability safe.
;;
;; Phase 1 implements the trusted-signer slice (admin + signer list + setters).
;; Phase 3 adds the stale-price threshold: `pyth-lazer-storage` reads it for its
;; read-side staleness check (decision #3), so it lands with storage rather than
;; in Phase 4. Phase 4 adds: blessed `decoder` principal and the fee value
;; (default u0), plus per-signer set/remove ergonomics.
;;
;; TODO(governance): v1 uses a single `contract-admin` principal, defaulting to the deployer.
;; This mirrors Pyth's own reference contracts (single owner / top-authority). Options to
;; harden governance in future versions, in rough order of effort:
;;   1. Two-step admin handoff (set-pending-admin / accept-admin) to avoid fat-fingering a
;;      transfer to an unusable address.
;;   2. Reassign admin to a Stacks multisig principal (no code change, just transfer admin).
;;   3. Multiple admins / role separation (e.g. signer-manager vs fee-setter vs upgrader).
;;   4. Fine-grained, per-action permissions (allowlist of (principal, action) pairs).
;;   5. Lazer-signed governance: accept signed governance messages from Pyth (parsed like the
;;      EVM contract's updateTrustedSigner authority) instead of a Stacks-principal admin.
;;   6. Timelock / delay on sensitive changes (trusted-signer rotation, fee hikes, upgrades).

;;;; Constants

;; Caller is not the contract admin
(define-constant ERR_UNAUTHORIZED (err u4003))

;;;; Data vars

;; Single admin principal; defaults to the deployer (tx-sender at deploy time).
(define-data-var contract-admin principal tx-sender)

;; Trusted Lazer signers: compressed secp256k1 pubkeys, each with an expiry
;; (unix seconds). A signature is valid only while `now < expires-at` (PLAN 3.5).
;; The decoder reads this list and applies the membership + expiry check.
(define-data-var trusted-signers
	(list 16 { pubkey: (buff 33), expires-at: uint })
	(list))

;; Stale-price threshold, in SECONDS. Storage treats a stored price as fresh while
;; `now - (publish-time / 1_000_000) <= threshold` (Lazer publish-time is in us;
;; decision #3). Defaults mirror the old bridge: 2 hours on mainnet, ~5 years
;; elsewhere, so simnet/testnet reads never go stale until an admin tightens it.
(define-data-var stale-price-threshold uint
	(if is-in-mainnet u7200 u157680000)) ;; 2h (2*60*60) mainnet / ~5y (5*365*24*60*60) else

;;;; Read-only getters

(define-read-only (get-admin)
	(var-get contract-admin))

(define-read-only (get-trusted-signers)
	(var-get trusted-signers))

(define-read-only (get-stale-price-threshold)
	(var-get stale-price-threshold))

;;;; Admin functions

;; Replace the full trusted-signer set. Phase 4 will add per-signer
;; add/update/remove ergonomics (set-trusted-signer pubkey expires-at, with
;; expires-at = u0 meaning remove), per PLAN section 7.
(define-public (set-trusted-signers
		(signers (list 16 { pubkey: (buff 33), expires-at: uint })))
	(begin
		(asserts! (is-eq tx-sender (var-get contract-admin)) ERR_UNAUTHORIZED)
		(var-set trusted-signers signers)
		(print { type: "trusted-signers", action: "updated", data: signers })
		(ok true)))

(define-public (set-admin (new-admin principal))
	(begin
		(asserts! (is-eq tx-sender (var-get contract-admin)) ERR_UNAUTHORIZED)
		(var-set contract-admin new-admin)
		(print { type: "admin", action: "updated", data: new-admin })
		(ok true)))

;; Override the staleness window (seconds). Section 7: occasional admin tuning.
(define-public (set-stale-price-threshold (seconds uint))
	(begin
		(asserts! (is-eq tx-sender (var-get contract-admin)) ERR_UNAUTHORIZED)
		(var-set stale-price-threshold seconds)
		(print { type: "stale-price-threshold", action: "updated", data: seconds })
		(ok true)))
