import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { concatBytes, hexToBytes } from "@noble/hashes/utils";

// Deterministic test signer keypair (NOT a real Lazer key — synthetic fixture).
export const TEST_PRIVKEY = hexToBytes(
  "0101010101010101010101010101010101010101010101010101010101010101",
);
export const TEST_PUBKEY = secp256k1.getPublicKey(TEST_PRIVKEY, true); // 33-byte compressed

// A second, unrelated signer for "untrusted key" tests.
export const OTHER_PRIVKEY = hexToBytes(
  "0202020202020202020202020202020202020202020202020202020202020202",
);
export const OTHER_PUBKEY = secp256k1.getPublicKey(OTHER_PRIVKEY, true);

// EVM_FORMAT_MAGIC = 706910618 = 0x2a22999a, uint32 big-endian (PLAN 3.2).
export const EVM_FORMAT_MAGIC = Uint8Array.from([0x2a, 0x22, 0x99, 0x9a]);

/**
 * Build a Lazer `evm`-format update:
 *   magic(4) | r(32) | s(32) | recovery-id(1) | payload_len(u16 BE) | payload
 *
 * The signature is a recoverable secp256k1 ECDSA signature over
 * keccak256(payload) — exactly what the on-chain decoder recovers. The recovery
 * id is written as 0/1 (the EVM contract adds 27 only for Solidity's ecrecover;
 * Clarity's secp256k1-recover? wants the raw 0/1).
 */
export function buildEvmUpdate(
  payload: Uint8Array,
  privKey: Uint8Array = TEST_PRIVKEY,
): Uint8Array {
  const hash = keccak_256(payload);
  const sig = secp256k1.sign(hash, privKey); // canonical (low-s), recovery set
  const rs = sig.toCompactRawBytes(); // 64 bytes: r || s
  const v = Uint8Array.from([sig.recovery]); // 0 or 1
  const len = Uint8Array.from([(payload.length >> 8) & 0xff, payload.length & 0xff]);
  return concatBytes(EVM_FORMAT_MAGIC, rs, v, len, payload);
}
