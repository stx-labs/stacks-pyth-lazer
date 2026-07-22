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

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/**
 * Build an `evm`-format update signed with the malleable high-S twin (s' = n - s, recovery bit
 * flipped). Still a valid signature that recovers the same signer, but non-canonical — a
 * low-S-enforcing verifier must reject it.
 */
export function buildEvmUpdateHighS(
  payload: Uint8Array,
  privKey: Uint8Array = TEST_PRIVKEY,
): Uint8Array {
  const hash = keccak_256(payload);
  const sig = secp256k1.sign(hash, privKey); // canonical low-S, recovery set
  const highS = SECP256K1_N - sig.s; // upper-half twin
  const rs = concatBytes(uBE(sig.r, 32), uBE(highS, 32)); // r || s'
  const v = Uint8Array.from([sig.recovery ^ 1]); // flip recovery so recover? still yields the signer
  const len = Uint8Array.from([(payload.length >> 8) & 0xff, payload.length & 0xff]);
  return concatBytes(EVM_FORMAT_MAGIC, rs, v, len, payload);
}

// ---------------------------------------------------------------------------
// Lazer payload encoder (PLAN 3.3-3.4). Big-endian, matching the on-chain parser.
//
// CAVEAT: this encoder mirrors our parser by construction, so these fixtures
// prove the parser is *self-consistent* — they do NOT confirm the byte order /
// layout against real Lazer data. A real `evm` fixture is still needed (PLAN 10).
// ---------------------------------------------------------------------------

// FORMAT_MAGIC = 2479346549 = 0x93c7d375, uint32 big-endian.
export const LAZER_FORMAT_MAGIC = Uint8Array.from([0x93, 0xc7, 0xd3, 0x75]);

// PriceFeedProperty enum (PLAN 3.4 / PythLazerStructs).
export const PROP = {
  Price: 0,
  BestBidPrice: 1,
  BestAskPrice: 2,
  PublisherCount: 3,
  Exponent: 4,
  Confidence: 5,
  FundingRate: 6,
  FundingTimestamp: 7,
  FundingRateInterval: 8,
  MarketSession: 9,
  EmaPrice: 10,
  EmaConfidence: 11,
  FeedUpdateTimestamp: 12,
} as const;

// Fixed-width value size per type (bytes); 0-5 and 9-11 match the on-chain decoder.
// Types 6/7/8/12 are existence-flagged (see EXISTENCE_FLAGGED) and encoded separately.
const PROP_WIDTH: Record<number, number> = {
  0: 8, 1: 8, 2: 8, 3: 2, 4: 2, 5: 8, 9: 2, 10: 8, 11: 8,
};
const PROP_SIGNED: Record<number, boolean> = { 0: true, 1: true, 2: true, 4: true, 6: true, 10: true };

// Existence-flagged properties: a 1-byte flag, then an 8-byte value only when the flag is nonzero.
// In a FeedSpec, `null` encodes absent (flag 0); any bigint encodes present (flag 1 + value, incl. 0).
const EXISTENCE_FLAGGED = new Set([6, 7, 8, 12]);
const EXISTENCE_VALUE_WIDTH = 8;

function uBE(value: bigint, width: number): Uint8Array {
  const out = new Uint8Array(width);
  let x = value;
  for (let i = width - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

// A property value is a bigint, or null to encode an existence-flagged property as absent.
export type FeedSpec = { id: number; props: Array<[number, bigint | null]> };

/** Encode one property: type byte + value (two's-complement BE, type-dependent width).
 *  Existence-flagged types (6/7/8/12) emit a flag byte first; `null` encodes absent (flag 0). */
export function encodeProperty(type: number, value: bigint | null): Uint8Array {
  const signed = PROP_SIGNED[type] ?? false;
  if (EXISTENCE_FLAGGED.has(type)) {
    if (value === null) return Uint8Array.from([type, 0x00]); // flag 0 -> absent, no value bytes
    const raw = signed ? BigInt.asUintN(EXISTENCE_VALUE_WIDTH * 8, value) : value;
    return concatBytes(Uint8Array.from([type, 0x01]), uBE(raw, EXISTENCE_VALUE_WIDTH));
  }
  if (value === null) throw new Error(`property type ${type} is fixed-width; null is only valid for existence-flagged types`);
  const width = PROP_WIDTH[type] ?? 8; // unknown types still get 8 bytes of (unread) data
  const raw = signed ? BigInt.asUintN(width * 8, value) : value;
  return concatBytes(Uint8Array.from([type]), uBE(raw, width));
}

function encodeFeed(feed: FeedSpec): Uint8Array {
  return concatBytes(
    uBE(BigInt(feed.id), 4),
    Uint8Array.from([feed.props.length]),
    ...feed.props.map(([t, v]) => encodeProperty(t, v)),
  );
}

/** Build a Lazer payload: magic | timestamp(u64) | channel(u8) | feedsLen(u8) | feeds. */
export function buildLazerPayload(opts: {
  timestamp: bigint;
  channel: number;
  feeds: FeedSpec[];
}): Uint8Array {
  return concatBytes(
    LAZER_FORMAT_MAGIC,
    uBE(opts.timestamp, 8),
    Uint8Array.from([opts.channel]),
    Uint8Array.from([opts.feeds.length]),
    ...opts.feeds.map(encodeFeed),
  );
}
