import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import { hexToBytes } from "@noble/hashes/utils";

// ---------------------------------------------------------------------------
// REAL Pyth Lazer `evm` golden fixture -- the byte-order / endianness anchor.
//
// Source: pyth-network/pyth-crosschain
//   lazer/contracts/evm/test/PythLazer.t.sol  (fn test_verify)
//   commit fca047c66d4f38f9efd3601feeb93b733aad520d
//   PythLazer.version() == "0.1.1"
//
// Unlike the synthetic fixtures in helpers.ts -- which our own TS encoder
// produces and which therefore share our byte assumptions -- these bytes were
// produced by Pyth's Rust/Solidity encoder and signed by a real secp256k1 key.
// Matching them confirms our big-endian transcription against production data,
// the single open item carried from Phase 2 (PLAN.md Phase 5, sections 9-10).
//
// The vector is a strong TLV test: properties arrive out of type order
// (Price, BestAsk, BestBid, PublisherCount, Exponent) and Confidence is absent,
// exercising out-of-order parsing, skip-by-width for unpersisted properties, and
// an omitted persisted property -- all on real bytes.
// ---------------------------------------------------------------------------

// Full evm envelope: magic(4) | r(32) | s(32) | recid(1) | payload_len(2 BE) | payload(52).
const REAL_UPDATE = hexToBytes(
  "2a22999a9ee4e2a3df5affd0ad8c7c46c96d3b5ef197dd653bedd8f44a4b6b69" +
    "b767fbc66341e80b80acb09ead98c60d169b9a99657ebada101f447378f227bf" +
    "fbc69d3d01003493c7d37500062cf28659c1e801010000000605000000000005" +
    "f5e10002000000000000000001000000000000000003000104fff8",
);

// The signed payload is the tail after the fixed 71-byte envelope header.
const REAL_PAYLOAD = REAL_UPDATE.slice(71);

// secp256k1 signer recovered (off-chain, via @noble/curves) from keccak256(payload)
// over the fixture's r||s||recid=1. Our system keys signers by 33-byte COMPRESSED
// pubkey (Clarity 5 has no secp256k1-decompress?), so this -- not an ETH address --
// is what governance trusts. It corresponds to the ETH address
// 0xb8d50f0bAE75BF6E03c104903d7C3aFc4a6596Da that PythLazer.t.sol asserts.
const REAL_SIGNER = hexToBytes(
  "033fa670134f8f961047bf009e0e4907c79005fdf83eef5eef13d2f36bb5cd048b",
);

// Expected decode, transcribed from the fixture's own Solidity assertions:
//   timestamp 1738270008001000 us, channel 1, one feed (id 6) with
//   price 100000000, exponent -8, confidence absent.
const EXPECTED_DECODE = Cl.tuple({
  timestamp: Cl.uint(1_738_270_008_001_000n),
  channel: Cl.uint(1),
  "price-feeds": Cl.list([
    Cl.tuple({
      "feed-id": Cl.uint(6),
      price: Cl.some(Cl.int(100_000_000n)),
      exponent: Cl.some(Cl.int(-8n)),
      confidence: Cl.none(),
    }),
  ]),
});

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;

const DECODER = "pyth-lazer-decoder-v1";
const GOV = "pyth-lazer-governance";

const FAR_FUTURE = 100_000_000_000n; // unix seconds, ~year 5138 -- never expired
const ERR_UNTRUSTED_SIGNER = 2105;

function trustRealSigner() {
  simnet.callPublicFn(
    GOV,
    "set-trusted-signers",
    [Cl.list([Cl.tuple({ pubkey: Cl.buffer(REAL_SIGNER), "expires-at": Cl.uint(FAR_FUTURE) })])],
    deployer,
  );
}

describe("pyth-lazer-decoder-v1: REAL Lazer evm golden fixture (byte-order anchor)", () => {
  it("decode-payload parses the real payload to Pyth's own decoded values (big-endian)", () => {
    // Pure byte-order check: no signature involved, just the payload layout.
    const { result } = simnet.callReadOnlyFn(DECODER, "decode-payload", [Cl.buffer(REAL_PAYLOAD)], deployer);
    expect(result).toBeOk(EXPECTED_DECODE);
  });

  it("recover-signer recovers the real signer's compressed pubkey on-chain", () => {
    // Confirms Clarity's secp256k1-recover? + keccak256 agree with the off-chain
    // reference recovery for real bytes, and that the envelope is sliced correctly.
    const { result } = simnet.callReadOnlyFn(DECODER, "recover-signer", [Cl.buffer(REAL_UPDATE)], deployer);
    expect(result).toBeOk(Cl.tuple({ signer: Cl.buffer(REAL_SIGNER), payload: Cl.buffer(REAL_PAYLOAD) }));
  });

  it("decode-and-verify-price-feeds accepts the real update end-to-end when its signer is trusted", () => {
    trustRealSigner();
    const { result } = simnet.callPublicFn(DECODER, "decode-and-verify-price-feeds", [Cl.buffer(REAL_UPDATE)], deployer);
    expect(result).toBeOk(EXPECTED_DECODE);
  });

  it("rejects the real update when its signer is not trusted (the signer path is genuinely exercised)", () => {
    // No trust() seeding: an empty trusted-signer set must reject even valid bytes,
    // proving the happy path above passes because of the signature, not in spite of it.
    const { result } = simnet.callPublicFn(DECODER, "decode-and-verify-price-feeds", [Cl.buffer(REAL_UPDATE)], deployer);
    expect(result).toBeErr(Cl.uint(ERR_UNTRUSTED_SIGNER));
  });
});
