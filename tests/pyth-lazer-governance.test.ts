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
