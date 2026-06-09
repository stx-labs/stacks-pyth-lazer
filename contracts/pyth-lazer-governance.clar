;; Title: pyth-lazer-governance
;; Version: v1 (Phase 0 scaffold)
;;
;; Config state for the oracle. IMMUTABLE (PLAN 6.4): holds NO hot-path logic
;; (trusted-signer validation lives in the swappable decoder), which is what
;; makes immutability safe. Phase 4 wires this up.
;;
;; Phase 4 adds:
;;   - `contract-admin` principal, defaulting to the deployer (decision #1)
;;   - trusted-signer list: (list 16 { pubkey: (buff 33), expires-at: uint })
;;     (compressed secp256k1 pubkeys; PLAN 3.5)
;;   - blessed `decoder` principal (the oracle validates the passed <decoder>
;;     against this; PLAN 6.4)
;;   - fee value (default u0) and stale-price threshold
;;   - admin-gated setters: set-trusted-signer, set-fee, set-stale-price-threshold,
;;     set-decoder, set-admin; read-only getters consumed by decoder/storage/oracle
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
