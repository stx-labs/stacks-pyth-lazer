import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import { TEST_PUBKEY } from "./helpers";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const wallet1 = accounts.get("wallet_1")!;

const GOV = "pyth-lazer-governance";
const ERR_UNAUTHORIZED = 4003;

const signerEntry = (expiresAt: bigint) =>
  Cl.tuple({ pubkey: Cl.buffer(TEST_PUBKEY), "expires-at": Cl.uint(expiresAt) });

describe("pyth-lazer-governance: trusted-signer slice", () => {
  it("defaults the admin to the deployer", () => {
    const { result } = simnet.callReadOnlyFn(GOV, "get-admin", [], deployer);
    expect(result).toBePrincipal(deployer);
  });

  it("starts with an empty trusted-signer set", () => {
    const { result } = simnet.callReadOnlyFn(GOV, "get-trusted-signers", [], deployer);
    expect(result).toBeList([]);
  });

  it("lets the admin set and read back trusted signers", () => {
    const set = simnet.callPublicFn(
      GOV,
      "set-trusted-signers",
      [Cl.list([signerEntry(100n)])],
      deployer,
    );
    expect(set.result).toBeOk(Cl.bool(true));

    const read = simnet.callReadOnlyFn(GOV, "get-trusted-signers", [], deployer);
    expect(read.result).toBeList([signerEntry(100n)]);
  });

  it("rejects a non-admin trying to set trusted signers", () => {
    const { result } = simnet.callPublicFn(
      GOV,
      "set-trusted-signers",
      [Cl.list([signerEntry(100n)])],
      wallet1,
    );
    expect(result).toBeErr(Cl.uint(ERR_UNAUTHORIZED));
  });

  it("transfers admin rights and revokes the old admin", () => {
    const transfer = simnet.callPublicFn(GOV, "set-admin", [Cl.principal(wallet1)], deployer);
    expect(transfer.result).toBeOk(Cl.bool(true));

    // old admin (deployer) can no longer set
    const old = simnet.callPublicFn(GOV, "set-trusted-signers", [Cl.list([])], deployer);
    expect(old.result).toBeErr(Cl.uint(ERR_UNAUTHORIZED));

    // new admin (wallet1) can
    const fresh = simnet.callPublicFn(GOV, "set-trusted-signers", [Cl.list([])], wallet1);
    expect(fresh.result).toBeOk(Cl.bool(true));
  });
});

describe("pyth-lazer-governance: stale-price threshold", () => {
  // simnet is not mainnet, so the default is the ~5-year window (seconds).
  const DEFAULT_THRESHOLD = 5n * 365n * 24n * 60n * 60n;

  it("defaults to the ~5-year non-mainnet window", () => {
    const { result } = simnet.callReadOnlyFn(GOV, "get-stale-price-threshold", [], deployer);
    expect(result).toBeUint(DEFAULT_THRESHOLD);
  });

  it("lets the admin override the threshold", () => {
    const set = simnet.callPublicFn(GOV, "set-stale-price-threshold", [Cl.uint(3600n)], deployer);
    expect(set.result).toBeOk(Cl.bool(true));

    const read = simnet.callReadOnlyFn(GOV, "get-stale-price-threshold", [], deployer);
    expect(read.result).toBeUint(3600n);
  });

  it("rejects a non-admin trying to set the threshold", () => {
    const { result } = simnet.callPublicFn(GOV, "set-stale-price-threshold", [Cl.uint(3600n)], wallet1);
    expect(result).toBeErr(Cl.uint(ERR_UNAUTHORIZED));
  });
});

describe("pyth-lazer-governance: blessed decoder", () => {
  it("defaults to the v1 decoder", () => {
    expect(simnet.callReadOnlyFn(GOV, "get-decoder", [], deployer).result)
      .toBePrincipal(`${deployer}.pyth-lazer-decoder-v1`);
  });

  it("lets the admin re-point the decoder", () => {
    const set = simnet.callPublicFn(GOV, "set-decoder", [Cl.principal(wallet1)], deployer);
    expect(set.result).toBeOk(Cl.bool(true));
    expect(simnet.callReadOnlyFn(GOV, "get-decoder", [], deployer).result).toBePrincipal(wallet1);
  });

  it("rejects a non-admin trying to set the decoder", () => {
    const { result } = simnet.callPublicFn(GOV, "set-decoder", [Cl.principal(wallet1)], wallet1);
    expect(result).toBeErr(Cl.uint(ERR_UNAUTHORIZED));
  });
});

describe("pyth-lazer-governance: fee", () => {
  it("defaults the fee to u0", () => {
    expect(simnet.callReadOnlyFn(GOV, "get-fee", [], deployer).result).toBeUint(0n);
  });

  it("lets the admin set the fee", () => {
    const set = simnet.callPublicFn(GOV, "set-fee", [Cl.uint(2500n)], deployer);
    expect(set.result).toBeOk(Cl.bool(true));
    expect(simnet.callReadOnlyFn(GOV, "get-fee", [], deployer).result).toBeUint(2500n);
  });

  it("rejects a non-admin trying to set the fee", () => {
    const { result } = simnet.callPublicFn(GOV, "set-fee", [Cl.uint(2500n)], wallet1);
    expect(result).toBeErr(Cl.uint(ERR_UNAUTHORIZED));
  });
});
