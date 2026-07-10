import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import { buildEvmUpdate, TEST_PUBKEY, OTHER_PUBKEY } from "./helpers";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;

const DECODER = "pyth-lazer-decoder-v1";
const ORACLE = "pyth-lazer-oracle";
const GOV = "pyth-lazer-oracle";
const decoderRef = Cl.contractPrincipal(deployer, DECODER);

// Error codes (PLAN 3.2 / decoder constants)
const ERR_INPUT_TOO_SHORT = 2101;
const ERR_INVALID_EVM_MAGIC = 2102;
const ERR_OVERLAY_PRESENT = 2103;
const ERR_UNTRUSTED_SIGNER = 2105;
const ERR_UNAUTHORIZED_CALLER = 2106;

// Far-future expiry (unix seconds, ~year 5138) so the signer is never expired.
const FAR_FUTURE = 100_000_000_000n;

const samplePayload = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03]);

function trust(pubkey: Uint8Array, expiresAt: bigint) {
  return simnet.callPublicFn(
    GOV,
    "set-trusted-signers",
    [Cl.list([Cl.tuple({ pubkey: Cl.buffer(pubkey), "expires-at": Cl.uint(expiresAt) })])],
    deployer,
  );
}

describe("pyth-lazer-decoder-v1: recover-signer (signature + envelope)", () => {
  it("recovers the signer and payload from a valid evm update", () => {
    const update = buildEvmUpdate(samplePayload);
    const { result } = simnet.callReadOnlyFn(DECODER, "recover-signer", [Cl.buffer(update)], deployer);
    expect(result).toBeOk(
      Cl.tuple({ signer: Cl.buffer(TEST_PUBKEY), payload: Cl.buffer(samplePayload) }),
    );
  });

  it("rejects a wrong magic prefix", () => {
    const update = buildEvmUpdate(samplePayload);
    update[0] = 0x00;
    const { result } = simnet.callReadOnlyFn(DECODER, "recover-signer", [Cl.buffer(update)], deployer);
    expect(result).toBeErr(Cl.uint(ERR_INVALID_EVM_MAGIC));
  });

  it("rejects input shorter than the 71-byte envelope header", () => {
    const update = buildEvmUpdate(samplePayload).slice(0, 70);
    const { result } = simnet.callReadOnlyFn(DECODER, "recover-signer", [Cl.buffer(update)], deployer);
    expect(result).toBeErr(Cl.uint(ERR_INPUT_TOO_SHORT));
  });

  it("rejects a declared payload length longer than the buffer", () => {
    const update = buildEvmUpdate(samplePayload);
    update[69] = 0xff; // payload_len high byte -> way past the buffer
    const { result } = simnet.callReadOnlyFn(DECODER, "recover-signer", [Cl.buffer(update)], deployer);
    expect(result).toBeErr(Cl.uint(ERR_INPUT_TOO_SHORT));
  });

  it("rejects trailing overlay bytes after the signed payload", () => {
    const update = Uint8Array.from([...buildEvmUpdate(samplePayload), 0xff]);
    const { result } = simnet.callReadOnlyFn(DECODER, "recover-signer", [Cl.buffer(update)], deployer);
    expect(result).toBeErr(Cl.uint(ERR_OVERLAY_PRESENT));
  });

  it("rejects a zero-length payload (not a valid Lazer update)", () => {
    // A real Lazer payload always carries a magic + header (enforced in Phase 2);
    // an empty payload can't be sliced (slice? start == len -> none) and is rejected.
    const update = buildEvmUpdate(new Uint8Array([]));
    const { result } = simnet.callReadOnlyFn(DECODER, "recover-signer", [Cl.buffer(update)], deployer);
    expect(result).toBeErr(Cl.uint(ERR_INPUT_TOO_SHORT));
  });
});

describe("pyth-lazer-decoder-v1: verify-update (trusted-signer check, via the oracle)", () => {
  // verify-update is callable only by the oracle now; the reject cases fail at the signer
  // check before payload parsing, so a throwaway payload is fine. The trusted-accept path is
  // exercised end-to-end in the oracle + golden-fixture suites.
  const verify = (update: Uint8Array) =>
    simnet.callPublicFn(ORACLE, "verify-price-feeds", [Cl.buffer(update), decoderRef, Cl.none()], deployer).result;

  it("rejects a direct (non-oracle) caller", () => {
    trust(TEST_PUBKEY, FAR_FUTURE); // even a trusted signer can't reach it directly
    const update = buildEvmUpdate(samplePayload);
    const { result } = simnet.callReadOnlyFn(DECODER, "verify-update", [Cl.buffer(update)], deployer);
    expect(result).toBeErr(Cl.uint(ERR_UNAUTHORIZED_CALLER));
  });

  it("rejects when no trusted signers are configured", () => {
    expect(verify(buildEvmUpdate(samplePayload))).toBeErr(Cl.uint(ERR_UNTRUSTED_SIGNER));
  });

  it("rejects an update signed by an untrusted key", () => {
    trust(OTHER_PUBKEY, FAR_FUTURE);
    expect(verify(buildEvmUpdate(samplePayload))).toBeErr(Cl.uint(ERR_UNTRUSTED_SIGNER)); // signed by TEST_PRIVKEY
  });

  it("rejects a trusted signer whose key has expired", () => {
    trust(TEST_PUBKEY, 1n); // expires-at = 1 (long past)
    expect(verify(buildEvmUpdate(samplePayload))).toBeErr(Cl.uint(ERR_UNTRUSTED_SIGNER));
  });

  it("rejects a tampered payload (recovered key is not the trusted signer)", () => {
    trust(TEST_PUBKEY, FAR_FUTURE);
    const update = buildEvmUpdate(samplePayload);
    update[update.length - 1] ^= 0xff; // flip a payload byte without re-signing
    expect(verify(update)).toBeErr(Cl.uint(ERR_UNTRUSTED_SIGNER));
  });
});
