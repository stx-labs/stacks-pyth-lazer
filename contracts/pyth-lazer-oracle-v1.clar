;; Title: pyth-lazer-oracle
;; Version: v1
;;
;; Description: Verification entry point for Pyth Lazer price feeds. Called by consumers/relayers.
;;
;; Verify-only: no on-chain price storage. Takes the <decoder> as a trait param, checks it
;; against governance's authorized decoder, dispatches to it, enforces the staleness window
;; and per-update fee, and RETURNS the parsed feeds for in-transaction use. Consumers who don't
;; need the fee / staleness / decoder-authorization guarantees can instead call
;; `pyth-lazer-decoder-v1.decode-and-verify-price-feeds` directly (a free read-only call).

(use-trait decoder-trait .pyth-lazer-traits.decoder-trait)

;;;; Constants

;; Passed decoder is not the governance-authorized one
(define-constant ERR_INVALID_DECODER (err u1001))
;; Update's publish-time is older than governance's staleness window
(define-constant ERR_STALE_PRICE (err u1002))

;; Lazer publish-time is microseconds; the staleness window is seconds
(define-constant MICROS_PER_SECOND u1000000)

;;;; Public functions

;; Verify a Lazer update via the governance-blessed decoder and return the parsed feeds.
;; Public (not read-only) because it dispatches to the decoder through a trait and may
;; charge a fee. Reverts if paused (enforced in the decoder), the signature/signer is
;; invalid, the decoder isn't the authorized one, or the update is stale.
(define-public (verify-price-feeds
    (update (buff 8192))
    (decoder <decoder-trait>)
  )
  (begin
    ;; Only the governance-authorized decoder is accepted
    (asserts!
      (is-eq (contract-of decoder)
        (contract-call? .pyth-lazer-governance get-decoder)
      )
      ERR_INVALID_DECODER
    )
    (let (
        ;; Decode + verify: signature, trusted signer, and the pause kill-switch are all
        ;; enforced inside the decoder.
        (decoded (try! (contract-call? decoder decode-and-verify-price-feeds update)))
        (publish-time-seconds (/ (get timestamp decoded) MICROS_PER_SECOND))
        (threshold (contract-call? .pyth-lazer-governance get-stale-price-threshold))
      )
      ;; Reject stale updates. Written additively (publish + threshold >= now) so a Lazer
      ;; publish-time running ahead of the current block time can't underflow the uint.
      (asserts! (>= (+ publish-time-seconds threshold) stacks-block-time) ERR_STALE_PRICE)
      (try! (charge-fee))
      (ok decoded)
    )
  )
)

;;;; Private functions

;; Charge the per-update fee (default u0) from tx-sender to governance's fee recipient.
;; `stx-transfer?` rejects a zero amount, so guard on it.
(define-private (charge-fee)
  (let ((fee (contract-call? .pyth-lazer-governance get-fee)))
    (if (> fee u0)
      (stx-transfer? fee tx-sender
        (contract-call? .pyth-lazer-governance get-fee-recipient)
      )
      (ok true)
    )
  )
)
