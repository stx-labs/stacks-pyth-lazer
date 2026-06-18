import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import { TEST_PUBKEY } from "./helpers";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!; // holds both roles + is the default fee recipient
const wallet1 = accounts.get("wallet_1")!; // holds no roles

const GOV = "pyth-lazer-governance";
const ERR_UNAUTHORIZED = 4003;
const ERR_PAUSED = 4004;

// Role IDs are opaque 1-byte discriminators (not bitflags); 0x00 is valid.
const ROLE_GOVERNANCE = Cl.buffer(Uint8Array.of(0));
const ROLE_PAUSE = Cl.buffer(Uint8Array.of(1));

const signerEntry = (expiresAt: bigint) =>
  Cl.tuple({ pubkey: Cl.buffer(TEST_PUBKEY), "expires-at": Cl.uint(expiresAt) });

const hasRole = (who: string, role: ReturnType<typeof Cl.buffer>) =>
  simnet.callReadOnlyFn(GOV, "has-role", [Cl.principal(who), role], deployer).result;

const setRole = (
  who: string,
  role: ReturnType<typeof Cl.buffer>,
  enabled: boolean,
  sender = deployer,
) => simnet.callPublicFn(GOV, "set-role", [Cl.principal(who), role, Cl.bool(enabled)], sender);

const setFee = (amount: bigint, sender = deployer) =>
  simnet.callPublicFn(GOV, "set-fee", [Cl.uint(amount)], sender);

describe("pyth-lazer-governance: roles", () => {
  it("grants the deployer both roles at deploy, and no one else any", () => {
    expect(hasRole(deployer, ROLE_GOVERNANCE)).toBeBool(true);
    expect(hasRole(deployer, ROLE_PAUSE)).toBeBool(true);
    expect(hasRole(wallet1, ROLE_GOVERNANCE)).toBeBool(false);
    expect(hasRole(wallet1, ROLE_PAUSE)).toBeBool(false);
  });

  it("lets governance grant a role, and the grantee can then act", () => {
    expect(setRole(wallet1, ROLE_GOVERNANCE, true).result).toBeOk(Cl.bool(true));
    expect(hasRole(wallet1, ROLE_GOVERNANCE)).toBeBool(true);
    expect(setFee(1n, wallet1).result).toBeOk(Cl.bool(true));
  });

  it("grant/revoke of one role never disturbs another the principal holds", () => {
    setRole(wallet1, ROLE_GOVERNANCE, true);
    setRole(wallet1, ROLE_PAUSE, true);
    expect(hasRole(wallet1, ROLE_GOVERNANCE)).toBeBool(true);
    expect(hasRole(wallet1, ROLE_PAUSE)).toBeBool(true);

    // revoke governance only -> pause grant survives
    expect(setRole(wallet1, ROLE_GOVERNANCE, false).result).toBeOk(Cl.bool(true));
    expect(hasRole(wallet1, ROLE_GOVERNANCE)).toBeBool(false);
    expect(hasRole(wallet1, ROLE_PAUSE)).toBeBool(true);
  });

  it("rejects a principal without the governance role granting roles", () => {
    expect(setRole(wallet1, ROLE_PAUSE, true, wallet1).result).toBeErr(Cl.uint(ERR_UNAUTHORIZED));
  });

  it("supports handing off control: grant the new holder, revoke the deployer", () => {
    setRole(wallet1, ROLE_GOVERNANCE, true);
    expect(setRole(deployer, ROLE_GOVERNANCE, false).result).toBeOk(Cl.bool(true));
    // deployer can no longer act as governance; wallet1 can
    expect(setFee(1n, deployer).result).toBeErr(Cl.uint(ERR_UNAUTHORIZED));
    expect(setFee(1n, wallet1).result).toBeOk(Cl.bool(true));
  });
});

describe("pyth-lazer-governance: pause", () => {
  it("starts unpaused", () => {
    expect(simnet.callReadOnlyFn(GOV, "is-paused", [], deployer).result).toBeBool(false);
  });

  it("lets the pause role pause and unpause", () => {
    expect(simnet.callPublicFn(GOV, "pause", [], deployer).result).toBeOk(Cl.bool(true));
    expect(simnet.callReadOnlyFn(GOV, "is-paused", [], deployer).result).toBeBool(true);
    expect(simnet.callPublicFn(GOV, "unpause", [], deployer).result).toBeOk(Cl.bool(true));
    expect(simnet.callReadOnlyFn(GOV, "is-paused", [], deployer).result).toBeBool(false);
  });

  it("rejects pause from a principal without the pause role", () => {
    expect(simnet.callPublicFn(GOV, "pause", [], wallet1).result).toBeErr(Cl.uint(ERR_UNAUTHORIZED));
  });

  it("blocks governance config changes while paused, yet unpause still works", () => {
    expect(simnet.callPublicFn(GOV, "pause", [], deployer).result).toBeOk(Cl.bool(true));
    // blocked with ERR_PAUSED even though the deployer holds the governance role
    expect(setFee(5n, deployer).result).toBeErr(Cl.uint(ERR_PAUSED));
    // pause/unpause are exempt from the pause gate, so recovery is always possible
    expect(simnet.callPublicFn(GOV, "unpause", [], deployer).result).toBeOk(Cl.bool(true));
    expect(setFee(5n, deployer).result).toBeOk(Cl.bool(true));
  });

  it("keeps pause distinct from governance (a pause-only holder cannot configure)", () => {
    setRole(wallet1, ROLE_PAUSE, true); // wallet1 gets pause only
    expect(simnet.callPublicFn(GOV, "pause", [], wallet1).result).toBeOk(Cl.bool(true));
    expect(simnet.callPublicFn(GOV, "unpause", [], wallet1).result).toBeOk(Cl.bool(true));
    expect(setFee(5n, wallet1).result).toBeErr(Cl.uint(ERR_UNAUTHORIZED));
  });
});

describe("pyth-lazer-governance: trusted-signer slice", () => {
  it("starts with an empty trusted-signer set", () => {
    expect(simnet.callReadOnlyFn(GOV, "get-trusted-signers", [], deployer).result).toBeList([]);
  });

  it("lets governance set and read back trusted signers", () => {
    const set = simnet.callPublicFn(GOV, "set-trusted-signers", [Cl.list([signerEntry(100n)])], deployer);
    expect(set.result).toBeOk(Cl.bool(true));
    expect(simnet.callReadOnlyFn(GOV, "get-trusted-signers", [], deployer).result).toBeList([signerEntry(100n)]);
  });

  it("rejects a non-governance principal setting trusted signers", () => {
    const { result } = simnet.callPublicFn(GOV, "set-trusted-signers", [Cl.list([signerEntry(100n)])], wallet1);
    expect(result).toBeErr(Cl.uint(ERR_UNAUTHORIZED));
  });
});

describe("pyth-lazer-governance: stale-price threshold", () => {
  // simnet is not mainnet, so the default is the ~5-year window (seconds).
  const DEFAULT_THRESHOLD = 5n * 365n * 24n * 60n * 60n;

  it("defaults to the ~5-year non-mainnet window", () => {
    expect(simnet.callReadOnlyFn(GOV, "get-stale-price-threshold", [], deployer).result).toBeUint(DEFAULT_THRESHOLD);
  });

  it("lets governance override the threshold", () => {
    expect(simnet.callPublicFn(GOV, "set-stale-price-threshold", [Cl.uint(3600n)], deployer).result).toBeOk(Cl.bool(true));
    expect(simnet.callReadOnlyFn(GOV, "get-stale-price-threshold", [], deployer).result).toBeUint(3600n);
  });

  it("rejects a non-governance principal setting the threshold", () => {
    expect(simnet.callPublicFn(GOV, "set-stale-price-threshold", [Cl.uint(3600n)], wallet1).result).toBeErr(Cl.uint(ERR_UNAUTHORIZED));
  });
});

describe("pyth-lazer-governance: blessed decoder", () => {
  it("defaults to the v1 decoder", () => {
    expect(simnet.callReadOnlyFn(GOV, "get-decoder", [], deployer).result)
      .toBePrincipal(`${deployer}.pyth-lazer-decoder-v1`);
  });

  it("lets governance set the blessed decoder to a conforming contract", () => {
    // set-decoder takes a <decoder-trait>, so the target must implement the interface;
    // the only one here is v1, so this re-blesses the default (a real upgrade is a -v2).
    const v1 = Cl.contractPrincipal(deployer, "pyth-lazer-decoder-v1");
    expect(simnet.callPublicFn(GOV, "set-decoder", [v1], deployer).result).toBeOk(Cl.bool(true));
    expect(simnet.callReadOnlyFn(GOV, "get-decoder", [], deployer).result)
      .toBePrincipal(`${deployer}.pyth-lazer-decoder-v1`);
  });

  it("rejects a non-governance principal setting the decoder", () => {
    const v1 = Cl.contractPrincipal(deployer, "pyth-lazer-decoder-v1");
    expect(simnet.callPublicFn(GOV, "set-decoder", [v1], wallet1).result).toBeErr(Cl.uint(ERR_UNAUTHORIZED));
  });
});

describe("pyth-lazer-governance: fee + fee recipient", () => {
  it("defaults the fee to u0 and the recipient to the deployer", () => {
    expect(simnet.callReadOnlyFn(GOV, "get-fee", [], deployer).result).toBeUint(0n);
    expect(simnet.callReadOnlyFn(GOV, "get-fee-recipient", [], deployer).result).toBePrincipal(deployer);
  });

  it("lets governance set the fee", () => {
    expect(setFee(2500n).result).toBeOk(Cl.bool(true));
    expect(simnet.callReadOnlyFn(GOV, "get-fee", [], deployer).result).toBeUint(2500n);
  });

  it("lets governance set the fee recipient", () => {
    expect(simnet.callPublicFn(GOV, "set-fee-recipient", [Cl.principal(wallet1)], deployer).result).toBeOk(Cl.bool(true));
    expect(simnet.callReadOnlyFn(GOV, "get-fee-recipient", [], deployer).result).toBePrincipal(wallet1);
  });

  it("rejects a non-governance principal setting the fee", () => {
    expect(setFee(2500n, wallet1).result).toBeErr(Cl.uint(ERR_UNAUTHORIZED));
  });
});
