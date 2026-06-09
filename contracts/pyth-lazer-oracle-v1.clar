;; Title: pyth-lazer-oracle
;; Version: v1 (Phase 0 scaffold)
;;
;; Thin orchestrator and stable WRITE entry point (PLAN 5, 6.4). Hardcodes
;; `.pyth-lazer-storage` and `.pyth-lazer-governance`; takes the `<decoder>` as a
;; trait param and validates it against governance's blessed decoder; charges the
;; fee. Relayers call here to submit updates; consumers READ storage directly.
;;
;; Phase 4 adds:
;;   - verify-and-update-price-feeds (update (buff N)) (decoder <decoder-trait>):
;;       validate decoder vs governance -> decode+verify -> write to storage ->
;;       charge fee (default u0)
;;   - read-price-feed / get-price passthroughs (optional; storage is the anchor)
