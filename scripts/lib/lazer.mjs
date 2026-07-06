// Shared helpers for the Lazer capture/measurement scripts in ../.
// Keep API-touching bits (the SDK client) behind a lazy import so constant-only
// consumers (e.g. measure-costs) don't load the streaming SDK.
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils";

export { hexToBytes, bytesToHex };

// Pyth's production secp256k1 signer (compressed pubkey). Every captured fixture
// recovers to this, and governance trusts it on-chain.
export const PROD_SIGNER = "03a4380f01136eb2640f90c17e1e319e02bbafbeef2e6e67dc48af53f9827e155b";

// Hosted Lazer stream endpoints (the pool the SDK fans out across).
export const WS_URLS = [
  "wss://pyth-lazer-0.dourolabs.app/v1/stream",
  "wss://pyth-lazer-1.dourolabs.app/v1/stream",
  "wss://pyth-lazer-2.dourolabs.app/v1/stream",
];

export const EVM_MAGIC = 0x2a22999a;

// Fail fast with a uniform hint when the access token is missing.
export function requireToken() {
  const token = process.env.PYTH_API_KEY;
  if (!token) {
    console.error("PYTH_API_KEY not set. Run: node --env-file=.env scripts/<script>.mjs");
    process.exit(1);
  }
  return token;
}

// evm envelope: magic(4) | r(32) | s(32) | recid(1) | payload_len(2) | payload.
// The Lazer payload's channel byte sits at payload offset 12 (magic4 + timestamp8),
// i.e. update offset 71 + 12 = 83.
export const channelByte = (evm) => evm[83];
export const hasEvmMagic = (evm) => (((evm[0] << 24) | (evm[1] << 16) | (evm[2] << 8) | evm[3]) >>> 0) === EVM_MAGIC;

// Recover the secp256k1 signer of one `evm` update (Uint8Array). Returns the 33-byte
// compressed pubkey (governance keys on this) and the derived 20-byte eth address, hex.
export function recoverSigner(evm) {
  const r = evm.slice(4, 36), s = evm.slice(36, 68), recid = evm[68];
  const len = (evm[69] << 8) | evm[70];
  const payload = evm.slice(71, 71 + len);
  const pub = secp256k1.Signature.fromCompact(bytesToHex(r) + bytesToHex(s)).addRecoveryBit(recid).recoverPublicKey(keccak_256(payload));
  return { compressed: bytesToHex(pub.toRawBytes(true)), ethAddr: bytesToHex(keccak_256(pub.toRawBytes(false).slice(1)).slice(12)) };
}

// SDK client over the hosted stream pool (lazy SDK import; see file header).
export async function createLazerClient(token) {
  const { PythLazerClient } = await import("@pythnetwork/pyth-lazer-sdk");
  return PythLazerClient.create({ token, webSocketPoolConfig: { urls: WS_URLS } });
}

// Append the access token as the query param the gateway expects, for the raw-ws
// capturer (the SDK's typed Channel can't express fixed_rate@1000ms).
export function authedWsUrl(base, token) {
  const u = new URL(base);
  u.searchParams.set("ACCESS_TOKEN", token);
  return u.toString();
}
