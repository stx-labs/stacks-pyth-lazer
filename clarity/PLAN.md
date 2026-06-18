# Stacks ⇄ Pyth Lazer — Implementation Plan

> Status: **Phases 0–4 done; next is Phase 5 (hardening) — see §8.**
> Goal: replace the Wormhole-based `stacks-pyth-bridge` (Pythnet pull oracle) with a
> new set of Clarity contracts that consume **Pyth Lazer** ("Pyth Pro") signed price
> updates, ahead of Pythnet being discontinued.

---

## 1. Why this project exists

The current [`stacks-pyth-bridge`](../stacks-pyth-bridge) brings Pyth prices to Stacks
through **Pythnet + Wormhole**:

1. Pyth aggregates prices on **Pythnet**, builds a Merkle accumulator, and a Wormhole
   message attests the **Merkle root**.
2. A user pulls a price update (a "PNAU" blob) from Hermes, containing the Wormhole VAA
   plus per-price **Merkle proofs**.
3. On Stacks, `wormhole-core-v4` verifies **13-of-19 guardian secp256k1 signatures** over
   the VAA; `pyth-pnau-decoder-v3` checks each price's Merkle proof against the attested
   root; `pyth-storage-v4` stores the latest price per feed.

**Pythnet (and this Wormhole attestation path) is being sunset.** Pyth's replacement is
**Pyth Lazer** — a low-latency oracle where a small set of **trusted signers** sign price
payloads *directly*. No Pythnet, no Wormhole guardians, no Merkle accumulator.

This repo (`stacks-pyth-lazer`) is a clean re-implementation targeting the Lazer protocol.

---

## 2. How Lazer differs from the Wormhole bridge

| Concern | `stacks-pyth-bridge` (today) | `stacks-pyth-lazer` (this project) |
|---|---|---|
| Trust root | 19 Wormhole guardians, 13/19 quorum | Small set of **trusted signers** (often 1), each with an **expiry** |
| Signature | secp256k1 ECDSA ×13+, over a Wormhole VAA body | **one** secp256k1 ECDSA over `keccak256(payload)` |
| Data integrity | Wormhole attests a Merkle **root**; each price carries a Merkle **proof** | Signer signs the **whole payload**; no Merkle proofs |
| Feed identifier | 32-byte price-feed id (`buff 32`) | small **`uint32`** feed id |
| Timestamp units | seconds | **microseconds** (`timestampUs`) |
| Envelope | `PNAU` magic → VAA → accumulator update | `EVM` format magic → 65-byte sig → payload |
| Governance | Wormhole governance VAAs (`PTGM`) | Single admin principal (defaults to deployer), no Wormhole; see §6 |
| Clarity contracts needed | wormhole-core, wormhole-traits, decoder, storage, oracle, governance | **No wormhole layer**, no Merkle code — see §5 |

**Net effect:** we delete the entire Wormhole layer and all Merkle-proof verification, and
replace 13 signature checks with one. The signature primitive and address/key handling are
identical to what `wormhole-core-v4` already does, so that logic is directly reusable.

---

## 3. Lazer protocol reference (verified against the EVM contracts)

Source of truth: [`pyth-network/pyth-crosschain` → `lazer/contracts/evm`](https://github.com/pyth-network/pyth-crosschain/tree/main/lazer/contracts/evm)
(`PythLazer.sol`, `PythLazerLib.sol`, `PythLazerStructs.sol`) and the Rust
`pyth-lazer-protocol` crate. **Transcribe exact offsets/endianness from these during
implementation and pin to a commit; the values below are the design reference.**

### 3.1 Signature formats

Lazer can emit three encodings of the same payload:

- **`evm`** — secp256k1 ECDSA over `keccak256(payload)`, 65-byte signature. ← **we use this**
- `solana` — ed25519 (no native ed25519 until Clarity 6's `ed25519-verify`; see §4.1).
- `leUnsigned` — no signature (off-chain use only).

The `evm` format is the only one Clarity 5 can verify with native ops, which is why this
project targets it. We request the `evm` format from the Lazer API / SDK. (Clarity 6 would
also make the `solana`/ed25519 format viable — §4.1.)

### 3.2 EVM update envelope (`PythLazer.sol::verifyUpdate`)

```
offset  size  field
0       4     EVM_FORMAT_MAGIC = 706910618 (0x2A22999A), uint32 BE
4       32    signature r
36      32    signature s
68      1     recovery id v   (0 or 1 on the wire; EVM adds 27, Clarity does NOT)
69      2     payload_len, uint16 BE
71      N     payload          (exactly payload_len bytes; this is what is hashed)
```

Verification:
- `keccak256(payload)` is the signed message hash.
- The 65-byte signature for `secp256k1-recover?` is simply `update[4:69]` (`r ‖ s ‖ v`),
  already contiguous — no reassembly needed.
- `secp256k1-recover?` returns a **33-byte compressed pubkey** → compare to the stored
  trusted signer key (Lazer's signer identity is a compressed secp256k1 pubkey).

### 3.3 Payload header (`PythLazerLib.sol::parsePayloadHeader`)

```
offset  size  field
0       4     FORMAT_MAGIC = 2479346549 (0x93C7D375), uint32 BE
4       8     timestamp (microseconds), uint64 BE
12      1     channel   (enum, see below)
13      1     feedsLen  (number of feeds), uint8
14      ...   feeds
```

`Channel`: `0 Invalid, 1 RealTime, 2 FixedRate50, 3 FixedRate200, 4 FixedRate1000`.

### 3.4 Per-feed layout (`parseFeedHeader` then properties)

```
4     feed_id        uint32 BE
1     num_properties uint8
repeated num_properties times:
  1   property_type  uint8 (PriceFeedProperty enum)
  K   value          width depends on property_type (see table)
```

`PriceFeedProperty` enum + value widths (from `PythLazerStructs.sol`):

| # | Property | Wire type | Bytes |
|---|---|---|---|
| 0 | Price | int64 | 8 |
| 1 | BestBidPrice | int64 | 8 |
| 2 | BestAskPrice | int64 | 8 |
| 3 | PublisherCount | uint16 | 2 |
| 4 | Exponent | int16 | 2 |
| 5 | Confidence | uint64 | 8 |
| 6 | FundingRate | int64 | 8 |
| 7 | FundingTimestamp | uint64 | 8 |
| 8 | FundingRateInterval | uint64 | 8 |
| 9 | MarketSession | uint8 | 1 |
| 10 | EmaPrice | int64 | 8 |
| 11 | EmaConfidence | uint64 | 8 |
| 12 | FeedUpdateTimestamp | uint64 | 8 |

Notes:
- The property list is **sequential TLV** — you must walk every property to find the next
  feed; you cannot index into it. Mirror `PythLazerLib`'s "always advance the cursor" rule.
- A subscription chooses *which* properties are present, so the parser must be
  property-driven (read type byte → read its fixed width), not fixed-layout.
- `price` is an `int64` mantissa; the real price is `price * 10^exponent` (exponent `int16`).
- v1 persists a core subset (`price`, `exponent`, `confidence`, publish/feed timestamp); the
  storage schema reserves the rest as optionals — see decision #4 / §6.4.

### 3.5 Trusted signers

- Identity: 33-byte **compressed secp256k1 pubkey** (DAO proposals reference keys like
  `0x03a4380f0113…`).
- Each signer has an **`expiresAt`** timestamp; a signature is valid only while
  `now < expiresAt`. Supports key rotation (add new, let old expire).
- EVM stores up to 100 signers; on Stacks a small list (e.g. `(list 16 {...})`) is plenty.
- We store the **compressed pubkey** and compare it directly to `secp256k1-recover?`'s output,
  so no `secp256k1-decompress?` (Clarity 6) is needed. The EVM contract instead keys on a
  20-byte ETH address; matching *that* form on-chain would require decompression — see §4.1.

### 3.6 What governance model does Pyth itself prescribe?

Researched — **Pyth provides no integrator-specific governance framework**. Their own
reference contracts expose only a **single owner / top-authority**:

- EVM `PythLazer.sol` is `OwnableUpgradeable` with a `_topAuthority` set at `initialize`;
  only that owner can call `updateTrustedSigner` / set the fee / upgrade.
- The Solana contract uses the same single `top_authority` pattern.
- The "Pyth DAO / Pythian council" governance (the `OP-PIP-*` proposals that assign signers)
  is an **off-chain** process; on-chain it resolves to one privileged address making the call.

So "single admin, defaulting to the deployer" is **not** a deviation from Pyth's design — it
*is* Pyth's design, with the deployer standing in for what is a DAO/multisig address in
production. This settles decision #1 below.

---

## 4. Feasibility in Clarity

| Need | Clarity capability | Reuse from existing bridge? |
|---|---|---|
| `keccak256(payload)` | `keccak256` builtin | — |
| Recover signer from sig | `secp256k1-recover?` (returns compressed key) | ✅ same pattern as `wormhole-core-v4` |
| Compare recovered ↔ trusted key | buffer `is-eq` | ✅ trivial |
| Byte parsing (uint8/16/32/64, int16/32/64, buff slices) | `slice?`, `buff-to-uint-be`, `buff-to-int-be`, `bit-shift-*` | ✅ port helpers from decoder/governance verbatim |
| Staleness vs wall clock | `get-stacks-block-info? time` (seconds) | ✅ pattern from `pyth-storage-v4` (must convert µs→s) |
| ed25519 (Lazer `solana` fmt) | ❌ not in Clarity 5 (Clarity 6: `ed25519-verify`) | n/a — v1 uses the `evm`/secp256k1 format |

**Conclusion: fully feasible with native Clarity 5, no new cryptography.** The hard part is
faithful byte-parsing + good fixtures, not crypto.

### 4.1 Clarity version: target 5 now, Clarity 6 on the horizon

Target **Clarity 5** (`Clarinet.toml`: `clarity_version = 5`, with the matching `epoch` —
confirm the exact Stacks epoch that ships Clarity 5 at scaffold). The old bridge is on
Clarity 3; nothing here needs anything newer than Clarity 5.

Clarity 6 (SIP-43; activates at Stacks **Epoch 4.0**, not yet live) adds built-ins that would
simplify this project. Ship the Clarity 5 path now and tag each spot with a `;; CLARITY6:`
comment so they're trivial to find when Epoch 4.0 lands. Because the **decoder is our one
swappable contract (§6.4)**, adopting Clarity 6 later is just "deploy a Clarity 6 `decoder-v2`
and re-bless it" — no migration of the rest.

| Clarity 6 feature | Where it would help here | Clarity 5 path we ship now |
|---|---|---|
| `secp256k1-decompress?` | Derive an ETH **address** from the recovered compressed key on-chain (the SIP gives this exact example) → enables address-form trusted-signer identity | Use **compressed-pubkey** identity: compare `secp256k1-recover?`'s 33-byte output directly to the stored key — no decompression (§3.5). Avoids the Wormhole-style uncompressed-key workaround the SIP cites as a downtime cause. |
| `ed25519-verify` | Verify Lazer's `solana` (ed25519) format, removing the secp256k1-only lock | secp256k1 only — request the `evm` format from Lazer (§3.1). |
| variadic `concat` | Flatter buffer assembly `(concat a b c d)` | nested `concat` — **low impact here**; the decoder is slice/parse-dominant, so this is mostly test-fixture / re-serialization readability. |
| `_` / underscore bindings | Discard unused accumulator fields in fold-based parsers without linter noise | name and ignore the binding. |

The first two are the substantive ones; variadic `concat` and `_` are readability niceties
given how little this codebase concatenates or serializes.

---

## 5. Target architecture

Keep the trait-based split of the current bridge, minus the Wormhole layer and the Merkle
decoder.

```
   reader (dapp)                          relayer / price updater
        │ get-price  (read-only)                │ verify-and-update-price-feeds
        │                                       │   (passes <decoder> as a trait param)
        ▼                                       ▼
 ┌────────────────────────┐ write (auth) ┌──────────────────────────┐
 │  pyth-lazer-storage     │◄─────────────│  pyth-lazer-oracle-v1     │
 │  ── IMMUTABLE ──        │ hardcoded ref│  thin orchestrator;       │
 │  feed-id → price record │              │  hardcodes storage +      │
 │  + monotonic guard      │              │  governance; charges fee  │
 └──────────┬──────────────┘              └─────────────┬────────────┘
            │ reads stale threshold                     │ decode + verify
            │                                            ▼  (param validated vs governance)
            │                                ┌──────────────────────────┐
            │                                │  pyth-lazer-decoder-v1     │ ── SWAPPABLE ──
            │                                │  sig recovery + trusted-   │
            │                                │  signer validation         │
            │                                └─────────────┬────────────┘
            ▼                                              │ reads signer list
 ┌──────────────────────────────────────────────────────────────────────┐
 │  pyth-lazer-governance   ── IMMUTABLE ──                               │
 │  admin · trusted signers {pubkey, expires-at} · fee · stale threshold  │
 └──────────────────────────────────────────────────────────────────────┘
```

Contracts:

- **`pyth-lazer-traits`** ⟨immutable⟩ — `storage-trait`, `decoder-trait`, `proxy-trait`.
  Feed id is `uint`; no `wormhole-core-trait`.
- **`pyth-lazer-decoder-v1`** ⟨**swappable** — the only volatile contract⟩ — owns the
  security-critical path; passed to the oracle as a trait param, validated against governance's
  blessed decoder principal. Steps:
  1. check `EVM_FORMAT_MAGIC`, slice signature + payload;
  2. `secp256k1-recover?` over `keccak256(payload)`;
  3. assert recovered key ∈ governance's trusted signers && not expired;
  4. check payload `FORMAT_MAGIC`, parse header + feeds → price records.
  No Merkle proof code (unlike `pyth-pnau-decoder-v3`).
- **`pyth-lazer-storage`** ⟨immutable⟩ — `feed-id (uint) → price record`, a monotonic-publish-
  time guard, one admin-settable `authorized-writer`, and `print` events. Generous schema
  (optionals for deferred fields) so it never needs a shape change. The **stable read anchor**
  (readers call it directly); the staleness read pulls the threshold from governance (µs→s).
- **`pyth-lazer-oracle-v1`** — thin orchestrator + stable **write** entry:
  `verify-and-update-price-feeds` (takes the `<decoder>` param), charges fee. Hardcodes
  `.pyth-lazer-storage` + `.pyth-lazer-governance`.
- **`pyth-lazer-governance`** ⟨immutable⟩ — config state: admin (defaults to deployer, §3.6),
  trusted-signer list `{pubkey, expires-at}`, fee, stale threshold, + admin-gated
  setters/getters. Carries the §6a improvement TODO as a header comment.

**Naming convention:** updateable contracts carry a `-vN` suffix in their contract id
(`pyth-lazer-decoder-v1`, `pyth-lazer-oracle-v1`) so a successor can be deployed and switched
to (Stacks contracts are immutable once deployed). The permanent substrate —
`pyth-lazer-traits`, `pyth-lazer-storage`, `pyth-lazer-governance` — is **unversioned** so its
addresses never move; `decoder-v1` and a future `decoder-v2` both implement the same
unversioned `pyth-lazer-traits`. (Per old-bridge style, the `.clar` `;; Title:` stays the base
name and `;; Version:` carries the number.)

> Mutability rationale, rejected alternatives, and replay analysis: **§6.4**
> (principle: *upgrade the logic, not the state*).

---

## 6. Decisions

| # | Decision | Choice | Status |
|---|---|---|---|
| 1 | Governance / admin authorization | Single `contract-admin` principal, defaults to deployer (see §3.6, §6a) | ✅ Decided |
| 2 | Feed-id representation | Native `uint` (not `buff 4`/`buff 32`) — see §6.2 | ✅ Decided |
| 3 | Timestamp unit in API | Store **microseconds**; convert to seconds only at the staleness comparison | ✅ Decided |
| 4 | Feed properties persisted in v1 | Decoder persists minimal (`price`, `exponent`, `confidence`, publish/feed time); storage *schema* reserves the full set as optionals (§6.4) | ✅ Decided |
| 5 | Consumer migration | Coexist with the old bridge; no `buff 32` adapter; document the new read API | ✅ Decided |
| 6 | Fee model | Keep the configurable per-update STX fee mechanism, default `u0` | ✅ Decided |
| 7 | Channel policy | Record/emit the channel; accept any value (no allowlist in v1) — §6.3 | ✅ Decided |
| 8 | Upgradeability model | Only the decoder is swappable; storage + governance immutable; oracle thin, hardcodes them — §6.4 | ✅ Decided |
| 9 | Contract split | Keep all five contracts separate (no folding); storage is the read anchor — §6.4 | ✅ Decided |

### 6.2 Why `uint` for feed ids (decision #2)

Lazer feed ids are conceptually integers (feed `1` = BTC/USD, etc.) and a `uint32` always
fits losslessly in a Clarity `uint`. `uint` wins over `(buff 4)` because: (a) it has a single
**canonical** map-key form — `(buff 4)` would require enforcing exactly 4 bytes everywhere or
`0x01` and `0x00000001` become distinct keys; (b) consumers pass `u1` instead of
`0x00000001`; (c) the parser does one `buff-to-uint-be` at decode time and everything
downstream is a clean number. (The old bridge used `buff 32` only because the price-id was a
real 32-byte hash with no integer meaning — not the case here.)

### 6.3 Channel policy (decision #7) — record, don't enforce

Lazer "channels" are publish-cadence tiers (`RealTime`, `FixedRate50/200/1000` ms). The
payload header carries a `channel` byte, and the signature covers it, so it is trustworthy
metadata — not a security control. v1 **records/emits the channel and accepts any value**;
staleness already governs freshness. An admin-set channel allowlist can be added later if a
consumer needs a guaranteed cadence.

### 6.4 Upgradeability & contract split (decisions #8 / #9)

**Principle: upgrade the logic, not the state.** A contract that holds durable state is made
immutable; logic that might need fixing lives in a swappable contract, so it can be replaced
without losing state or hitting a re-init/bootstrap problem (e.g. "who is the admin of a
freshly redeployed governance, and where did the signer list go?").

Applying it:

- **Only `pyth-lazer-decoder-v1` is swappable.** It owns the security-critical hot path
  (signature recovery + trusted-signer validation), so a bug there *is* fixable. The oracle
  receives it as a trait parameter and validates `(contract-of decoder)` against governance's
  blessed decoder principal; the admin re-blesses a `decoder-v2` to upgrade. No execution-plan
  graph, no `check-execution-flow`.
- **`pyth-lazer-storage` is immutable** — dumb maps + a self-protecting monotonic-publish-time
  guard + one admin-settable `authorized-writer`. The only thing that could force a storage
  replacement is a *record-shape* change, which Clarity can't do in place; we pre-empt it by
  defining the record generously now, using `(optional …)` for fields the v1 decoder doesn't
  populate yet (this refines #4). Storage is the stable read anchor.
- **`pyth-lazer-governance` is immutable** — pure config state (admin, signers, fee,
  threshold) + admin-gated setters. The security-critical validation logic is deliberately
  kept *out* of it (it lives in the swappable decoder), which is what makes immutability safe.
  Its residual logic (signer add/update/remove) is admin-only and low-severity (expiry
  mitigates a stuck signer). Reassigning the admin to a multisig/DAO is a value change, not a
  contract change.
- **`pyth-lazer-oracle-v1`** is a thin orchestrator and the stable *write* entry. It hardcodes
  `.pyth-lazer-storage` + `.pyth-lazer-governance` (compile-time refs — a future oracle
  re-points to the *same* storage via its `authorized-writer`). Redeployed only for rare
  orchestration/fee changes; readers are unaffected because they read storage directly.

**Contract split (#9):** keep all five contracts separate (no folding). Separation buys
upgrade *continuity* — a consumed price oracle must never go blank mid-upgrade — and lets
storage be the permanent read anchor.

*Rejected alternatives:* (a) immutable-everything → can't fix a validation bug; (b)
admin-settable pointers everywhere → in Clarity that requires passing trait refs as params +
governance validation anyway, so it collapses toward the old-bridge execution-plan; (c) full
execution-plan + `check-execution-flow` → unjustified complexity given a single admin and
re-derivable state.

**Replay protection — no permanent per-message state needed.** Price updates are
*last-write-wins*: storage only accepts a feed update whose publish-time is **newer** than the
stored one, so replaying an old signed update is rejected and replaying the current one is a
harmless re-write. State is therefore **bounded by the number of feeds** (one map entry each),
not by the number of messages ever seen — unlike consume-once bridge/governance actions, which
need a growing set of consumed message hashes. No such set is required here.

### 6a. Governance — future improvements (carry into the governance contract as a TODO)

v1 deliberately ships the minimum: one admin principal = the deployer. The following are
**known ways to harden this later**; none are needed for a working v1, but the contract
should be written so they can be added without breaking the read/write API. Drop this block
in as a header comment in `pyth-lazer-governance` so it isn't lost:

```clarity
;; TODO(governance): v1 uses a single `contract-admin` principal, defaulting to the deployer.
;; This mirrors Pyth's own reference contracts (single owner / top-authority). Options to
;; harden governance in future versions, in rough order of effort:
;;   1. Two-step admin handoff (set-pending-admin / accept-admin) to avoid fat-fingering a
;;      transfer to an unusable address.
;;   2. Reassign admin to a Stacks multisig principal (no code change — just transfer admin).
;;   3. Multiple admins / role separation (e.g. signer-manager vs fee-setter vs upgrader).
;;   4. Fine-grained, per-action permissions (allowlist of (principal, action) pairs).
;;   5. Lazer-signed governance: accept signed governance messages from Pyth (parsed like the
;;      EVM contract's updateTrustedSigner authority) instead of a Stacks-principal admin.
;;   6. Timelock / delay on sensitive changes (trusted-signer rotation, fee hikes, upgrades).
```

---

## 7. Operations — the calls you make

Planned function set (names may shift in implementation). In the old Wormhole bridge every
admin action was a signed governance VAA; with single-admin Lazer they become plain
admin `contract-call?`s.

**Bootstrap — required once after deploy (admin only):**
- `set-trusted-signer (pubkey (buff 33)) (expires-at uint)` — register Pyth's current Lazer
  signer key + expiry. **Mandatory: nothing verifies until this is set** (Pyth's EVM guide
  flags this as the required step). `expires-at = u0` removes a signer.

**Occasional / ongoing (admin only):**
- `set-trusted-signer` again — **key rotation**: add the new key before the old expires.
- `set-fee (...)` — change the per-update fee (default `u0`).
- `set-stale-price-threshold (seconds uint)` — override the default staleness window.
- `set-admin` / two-step handoff — reassign admin to a multisig/DAO (§6a).
- `set-decoder (principal)` (governance) — bless a new `decoder-v2`; relayers then pass it.
- `set-authorized-writer (principal)` (storage) — re-point to a redeployed oracle.

**Usage — anyone (not the admin):**
- `verify-and-update-price-feeds (update (buff N))` on `pyth-lazer-oracle-v1` — submit a Lazer
  update; verifies signature, writes prices, pays fee. Relayers/dapps call this.
- `read-price-feed (feed-id uint)` / `get-price (feed-id uint)` — consumers read prices.

**Off-chain (not a contract call):**
- Fetch the signed update from the Lazer API / `@pythnetwork/pyth-lazer-sdk` in the **`evm`**
  format (feeds + properties + channel of your choice); that blob feeds
  `verify-and-update-price-feeds`.

> **Admin's job in one line:** deploy → `set-trusted-signer` (required) → optionally
> `set-fee`/`set-stale-price-threshold` → re-`set-trusted-signer` whenever Pyth rotates keys.
> Everything else is consumer-driven.

---

## 8. Implementation phases (tactical, small PRs)

Each phase is independently reviewable/mergeable.

- **Phase 0 — scaffold. ✅ DONE.** `Clarinet.toml` (`clarity_version = 5`), project layout,
  vitest + `clarinet-sdk` harness, CI, README, byte-reader helpers ported into the decoder.
- **Phase 1 — signature verification. ✅ DONE.** `pyth-lazer-decoder-v1`:
  `recover-signer` (envelope parse → `keccak256` → `secp256k1-recover?` → `{signer, payload}`,
  with magic / length / overlay guards) and `verify-update` (+ trusted-signer membership +
  expiry, reading the list from governance). Also stood up the **governance trusted-signer
  slice** (`get-trusted-signers` / admin-gated `set-trusted-signers` / `set-admin`; admin
  defaults to deployer) so the decoder stays pure (per §6.4). Tested with a synthetic
  `evm` fixture (real secp256k1 sig over keccak256 via `@noble/curves`): valid recovery,
  bad magic, short input, oversized length, overlay bytes, untrusted/expired/tampered → reject.
  _TODO: add a **real** Lazer `evm` fixture (see Phase 2 note); the synthetic fixture already
  exercises the identical crypto path._
- **Phase 2 — payload parsing. ✅ DONE.** `decode-and-verify-price-feeds` =
  `verify-update` then `decode-payload`: header (magic/timestamp/channel/feedsLen) + a
  property-driven, two-bounded-fold feed walker → per-feed `{ feed-id, price?, exponent?,
  confidence? }`, with a table of property widths to skip non-persisted properties and a final
  `offset == len(payload)` exact-consumption check. `MAX_FEEDS = 16`. Tested (synthetic
  payloads): single/multi feed, negative price, skipped non-persisted props, omitted props →
  `none`, wrong magic, too-many-feeds, unknown property type, payload overlay.
  _**Real-fixture endianness — DONE (Phase 5).** Validated against a real upstream `evm` vector
  (`pyth-crosschain` `PythLazer.t.sol` v0.1.1, commit `fca047c`) in
  `tests/pyth-lazer-golden-fixture.test.ts`: envelope layout, on-chain secp256k1 recovery, and
  the big-endian payload/feed parse all match Pyth's own asserted values. A second, live-captured
  3-feed production vector now also covers confidence(u64) + multi-feed on real bytes, and finalized
  the storage optional/required split (Phase 5 below)._
- **Phase 3 — storage. ✅ DONE.** `pyth-lazer-storage`: `prices` map (`uint` feed-id → generous
  record, with the deferred properties reserved as `(optional …)` so the immutable `write`
  signature never has to change — #4 / §6.4); a strictly-monotonic per-feed publish-time guard
  (the replay defense, §6.4); batch `write` (≤16 feeds, partial-success/last-write-wins) gated
  by an admin-settable `authorized-writer` via `contract-caller`; `get-price` (raw) and
  `read-price-with-staleness-check` (reads the threshold from governance, µs→s, additive form to
  avoid uint underflow — #3); and `print` events. Pulled the **stale-price-threshold** slice
  into `pyth-lazer-governance` here (var + getter + admin setter, default 2 h mainnet / 5 y else)
  because storage's staleness read depends on it. The `authorized-writer` setter is gated by
  governance's admin (single-admin, #1). Tested: writer auth (unset/non-admin/wrong-caller),
  write+read, not-found, monotonic guard (older/equal skipped, newer accepted), per-entry batch
  partial success, and staleness fresh/stale/not-found.
- **Phase 4 — oracle + governance. ✅ DONE.** `pyth-lazer-oracle-v1`:
  `verify-and-update-price-feeds (update (buff 8192)) (decoder <decoder-trait>)` — asserts
  `(contract-of decoder)` equals governance's blessed decoder (§6.4), dispatches the decoder,
  folds the decoded feeds into storage records (threading the update's publish-time + channel,
  and **enforcing** the required core fields the storage schema demands — the oracle is the
  optional→required boundary the storage FIXME flagged), writes to storage, then charges the
  per-update fee (default `u0`, routed to the admin). Added `decoder-trait` to
  `pyth-lazer-traits` (public method — Clarity trait methods can't be read-only, so the
  decoder's `decode-and-verify-price-feeds` flipped from read-only to public + `impl-trait`).
  Governance gained the blessed `decoder` (optional, admin-set) and `fee` (default `u0`)
  slices. No execution-plan; storage stays the read anchor (oracle exposes no reads). Tested:
  happy path (single + multi feed), unblessed/wrong decoder, propagated untrusted-signer
  failure, unauthorized-writer, missing-core-field enforcement, and fee charged / not-charged.
  Bootstrap is a single required admin call (`set-trusted-signers`): the blessed decoder and
  storage's authorized-writer **default to the v1 contracts** (a principal literal is an address
  value, not a deploy-order edge — verified), so `set-decoder` / `set-authorized-writer` are
  upgrade-time re-pointing calls, not bootstrap. _(Deferred: per-signer add/remove ergonomic over
  `set-trusted-signers`.)_
- **Phase 5 — hardening.** Overlay/trailing-byte checks, malformed-input tests,
  fuzz the parser against the Rust/JS SDK output, audit prep.
  - ✅ **Cost/gas review** ([`docs/cost-review.md`](./docs/cost-review.md), measured 2026-06-18,
    reproduce with `scripts/measure-costs.mjs`): a max 16-feed update submitted end-to-end is
    ~0.77% of block runtime (the binding dimension), ~129 such updates/block; all other dimensions
    <0.4%. Parser dominates and scales ~linearly (~2.0M runtime/feed) over a ~1.7M fixed
    signature+header overhead. De-duplicating repeated `get`s on the buffer-carrying fold state
    trimmed per-feed runtime ~18%; no further optimization required.
  - ✅ **Byte order validated against a real Lazer `evm` fixture** (the open item from Phase 2):
    `tests/pyth-lazer-golden-fixture.test.ts` decodes an upstream `PythLazer.t.sol` v0.1.1 vector
    end-to-end (envelope + secp256k1 recovery + big-endian payload) to Pyth's own asserted values.
  - ✅ **Storage schema finalized** (resolves the storage `DO NOT SHIP` FIXME). Live BTC/ETH/SOL
    `evm` updates captured via `scripts/gen-lazer-fixture.mjs` + `pyth-lazer-protocol`'s
    `AggregatedPriceFeedData` set the optional/required split: REQUIRED `price` (oracle SKIPS a
    price-less feed -- partial success -- rather than rejecting), `exponent`, `publisher-count`
    (the two protocol non-`Option` fields); OPTIONAL `confidence`, `best-bid`, `best-ask`, `ema-*`,
    `feed-update-timestamp`. Storage stays permissive (immutable); "required" lives in the
    redeployable oracle. The immutable trait mirrors the full field vocabulary.
  - ✅ **Confidence(u64) width + multi-feed on real bytes**: real production updates
    (`tests/fixtures/captured/*.json`, captured + screened across asset types) are decoded against
    the SDK's own values in `tests/fixtures.test.ts`; the golden test also pins an inline PROD vector.
  - Production trusted signer observed: compressed pubkey
    `0x03a4380f01136eb2640f90c17e1e319e02bbafbeef2e6e67dc48af53f9827e155b` (it rotates via Pyth DAO --
    re-confirm at deploy, PLAN 10).
- **Phase 6 — deployment.** Testnet deploy + plan, a worked consumer example (port the
  `example/cbtc` integration), mainnet deployment plan, README with addresses.

---

## 9. Testing strategy

- Reuse the `clarinet-sdk` + `vitest` harness from `stacks-pyth-bridge` (`unit-tests/`).
- **Golden fixtures from the real Lazer API** in `evm` format are essential — generate with
  `@pythnetwork/pyth-lazer-sdk` and store request/response pairs. This is the single most
  important correctness lever (the EVM/Rust impls are the oracle of truth for byte layout).
- Negative tests: wrong envelope/payload magic, bad signature, expired signer, unknown
  signer, truncated payload, trailing-overlay bytes, stale price, replayed (older) price.
- Cross-check parsed values against `PythLazerLib` output / SDK decode for the same bytes.

---

## 10. Risks & notes

- **Endianness must be transcribed exactly** from `PythLazerLib.sol` / `pyth-lazer-protocol`
  per field (the EVM lib reads header + values big-endian via `shr`). Validate every field
  against real fixtures, not assumptions.
- **Microsecond timestamps.** Lazer is µs; Stacks block time is seconds. Per #3, store µs and
  convert (`/ u1000000`) only at the staleness comparison — apply it consistently.
- **Pin the upstream commit.** Magic numbers, the property enum, and the wire format can change
  across releases (the EVM contract is at `version()` `0.1.1`); record the exact
  `pyth-crosschain` commit the port targets.
- **Trusted-signer bootstrap.** Decide whether to seed an initial signer at deploy time or via
  the required post-deploy `set-trusted-signer` call (§7). Confirm the live mainnet/testnet
  Lazer signer key(s) from the current DAO proposals before deploy.
- **Property-set variability.** Because subscriptions decide which properties appear, the
  parser must handle any subset/order — do not hardcode a fixed feed layout.

---

## 11. References

- Pyth Lazer docs — payload reference: <https://docs.pyth.network/lazer/payload-reference>
- Pyth Lazer docs — EVM consumer: <https://docs.pyth.network/price-feeds/pro/integrate-as-consumer/evm>
- Reference EVM contracts: <https://github.com/pyth-network/pyth-crosschain/tree/main/lazer/contracts/evm>
- Lazer SDK (fixtures): `@pythnetwork/pyth-lazer-sdk` — <https://www.npmjs.com/package/@pythnetwork/pyth-lazer-sdk>
- Existing bridge (logic to reuse): [`../stacks-pyth-bridge`](../stacks-pyth-bridge)
  — esp. `contracts/wormhole/wormhole-core-v4.clar` (secp256k1 recovery), the byte-reader
  helpers in the decoder/governance, and `contracts/pyth-storage-v4.clar`.
