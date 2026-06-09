;; Title: pyth-lazer-storage
;; Version: v1 (Phase 0 scaffold)
;;
;; Durable price store: feed-id (uint) -> price record.
;; IMMUTABLE (PLAN 6.4): holds state only; tuned via the admin-settable
;; `authorized-writer`. It doubles as the stable READ anchor: consumers read
;; here directly, so its address must never move.
;;
;; Phase 3 adds:
;;   - `prices` map (feed-id -> generous price record; see pyth-lazer-traits)
;;   - per-feed monotonic publish-time guard (rejects older updates; this is the
;;     self-protecting invariant and the replay defense; PLAN 6.4)
;;   - `read` / `read-price-with-staleness-check` (staleness reads the threshold
;;     from governance and converts microseconds -> seconds, decision #3)
;;   - `write` gated by the admin-settable `authorized-writer` (the active oracle)
;;   - `print` events for chainhook consumers
