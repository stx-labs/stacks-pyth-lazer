# Stacks ⇄ Pyth Lazer

Clarity contracts for parsing and verifying **Pyth Lazer** ("Pyth Pro") price feeds on Stacks

This contract is a replacement for [`stacks-pyth-bridge`](../stacks-pyth-bridge), which relies on the deprecated Pythnet.
The new architecture is simpler (no Wormhole, no Merkle proofs) and will result in lower transaction costs.
However, due to changes in Pyth's licensing terms, we are not able to include price feed storage in these contracts.

## How it Works

A consumer supplies a signed Lazer update to the oracle in the **`evm`** format (one secp256k1 signature over `keccak256(payload)`).
The oracle verifies it through the decoder, and returns the parsed feeds for use in the same transaction: Nothing is persisted on-chain!

## Contracts

| Contract | Mutability | Role |
|---|---|---|
| `pyth-lazer-traits` | immutable | Trait definitions |
| `pyth-lazer-oracle` | immutable | Core contract: roles (governance/pause), trusted signers, fee, stale threshold, and the `verify-price-feeds` entry |
| `pyth-lazer-decoder-v1` | **swappable** | Verify signature + parse message; invoked only by the oracle |

Note that only the **decoder** carries a `-vN` suffix and can be updated!
The other contracts are immutable, and changing them would require a full redeployment.

## Build & Test

```bash
npm install    # install deps
npm test       # Run the unit tests (simnet)
clarinet check # Run Static analysis
```

Note that `npm test` relies on `clarinet-sdk`, so the `clarinet` binary isn't required for this step.

## Deployment

**Each party must deploy and govern its own instance.** Pyth's terms don't permit sharing a single deployment!

All three contracts must be deployed from the same account, since the `contract-call?`s are hard-coded to expect this.

| Setting | Default |
|---|---|
| trusted signers | `none` |
| fee / fee recipient | `u0` / deployer |
| stale threshold | `7200`s (mainnet) |
| decoder | `.pyth-lazer-decoder-v1` |
| paused | false |

### Bootstrap (required)

1. **`set-trusted-signers`**: Register Pyth's production signer(s). The current key is pinned as `PROD_SIGNER` in `scripts/lib/lazer.mjs` (Pyth can rotate it via their DAO)
2. **`set-stale-price-threshold`**: Override default staleness threshold (optional)
3. **Hand off roles** to your governance/pause accounts (see below)

`deployments/bootstrap-governance.testnet-plan.yaml` is a working example (Clarinet deployment plan).

## Governance

There are two roles, assigned using `set-role`.
By default, the contract deployer is granted both.
One principal can hold both roles, and one role can be held by many principals.

| Role | ID | Can |
|---|---|---|
| `ROLE_GOVERNANCE` | `0x00` | set signers / fee / decoder / stale-threshold, add/remove roles |
| `ROLE_PAUSE` | `0x01` | pause / unpause verification during an incident |

**Recommended setup:**
- A **multisig** for `ROLE_GOVERNANCE`
- A few **single-sig** `ROLE_PAUSE` accounts, ideally in different timezones for fast incident response

**Handing off from the deployer** (order matters):
1. The deployer `set-role`s the multisig as governance and the pausers as pause
2. The **multisig** then revokes the deployer. Governance can't remove its *own* governance role (anti-lockout), so the deployer can't revoke itself

**Additional notes:**
- Roles are checked against `contract-caller`, not `tx-sender`. Call the oracle directly!
- `set-trusted-signers` works even while **paused**, so a compromised signer can be rotated mid-incident
