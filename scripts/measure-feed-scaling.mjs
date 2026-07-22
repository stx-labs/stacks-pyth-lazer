// Measure how verify-price-feeds runtime scales with feed count, up to MAX_FEEDS.
// Captured fixtures top out at 16 feeds and are PROD-signed (unforgeable), so this
// synthesizes test-key-signed payloads with N feeds each carrying the 3 required
// fields (price/exponent/publisher-count) and measures the oracle end-to-end path.
//
//   node scripts/measure-feed-scaling.mjs
import { initSimnet } from "@stacks/clarinet-sdk";
import { Cl } from "@stacks/transactions";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { concatBytes, hexToBytes } from "@noble/hashes/utils";

const DECODER = "pyth-lazer-decoder-v1";
const ORACLE = "pyth-lazer-oracle";
const FAR_FUTURE = 100_000_000_000n;
const EVM_MAGIC = Uint8Array.from([0x2a, 0x22, 0x99, 0x9a]);
const LAZER_MAGIC = Uint8Array.from([0x93, 0xc7, 0xd3, 0x75]);
const TS = 1_700_000_000_000_000n; // micros

const PRIV = hexToBytes("0101010101010101010101010101010101010101010101010101010101010101");
const PUB = secp256k1.getPublicKey(PRIV, true);

const uBE = (v, w) => { const o = new Uint8Array(w); let x = v; for (let i = w - 1; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
// One feed: id(4) | num_props(1) | Price(0,i64) | Exponent(4,i16) | PublisherCount(3,u16)
const encodeFeed = (id) => concatBytes(
  uBE(BigInt(id), 4), Uint8Array.from([3]),
  Uint8Array.from([0]), uBE(BigInt.asUintN(64, 123456n + BigInt(id)), 8),
  Uint8Array.from([4]), uBE(BigInt.asUintN(16, -8n), 2),
  Uint8Array.from([3]), uBE(18n, 2),
);
const buildPayload = (n) => concatBytes(
  LAZER_MAGIC, uBE(TS, 8), Uint8Array.from([1]), Uint8Array.from([n]),
  ...Array.from({ length: n }, (_, i) => encodeFeed(i + 1)),
);
function buildEvmUpdate(payload) {
  const sig = secp256k1.sign(keccak_256(payload), PRIV);
  const len = Uint8Array.from([(payload.length >> 8) & 0xff, payload.length & 0xff]);
  return concatBytes(EVM_MAGIC, sig.toCompactRawBytes(), Uint8Array.from([sig.recovery]), len, payload);
}

const simnet = await initSimnet("Clarinet.toml", false, { trackCosts: true });
const deployer = simnet.getAccounts().get("deployer");
const relayer = simnet.getAccounts().get("wallet_1");
simnet.callPublicFn(ORACLE, "set-trusted-signers",
  [Cl.list([Cl.tuple({ pubkey: Cl.buffer(PUB), "expires-at": Cl.uint(FAR_FUTURE) })])], deployer);
simnet.callPublicFn(ORACLE, "set-stale-price-threshold", [Cl.uint(100_000_000_000_000n)], deployer);
const decoderRef = Cl.contractPrincipal(deployer, DECODER);

const rows = [];
for (const n of [1, 4, 8, 16, 24, 32]) {
  const upd = Cl.buffer(buildEvmUpdate(buildPayload(n)));
  const res = simnet.callPublicFn(ORACLE, "verify-price-feeds", [upd, decoderRef, Cl.none()], relayer);
  if (res.result.type !== "ok") throw new Error(`n=${n}: ${JSON.stringify(res.result)}`);
  rows.push({ n, runtime: res.costs.total.runtime, readLen: res.costs.total.readLength });
}

const limit = 5_000_000_000; // block runtime budget
const pad = (s, w) => String(s).padStart(w);
console.log(`\n${pad("feeds", 6)}${pad("runtime", 14)}${pad("% block", 10)}${pad("submits/block", 15)}`);
for (const r of rows) console.log(`${pad(r.n, 6)}${pad(r.runtime, 14)}${pad((100 * r.runtime / limit).toFixed(3), 10)}${pad(Math.floor(limit / r.runtime), 15)}`);
const a = rows[0], b = rows[rows.length - 1];
const perFeed = (b.runtime - a.runtime) / (b.n - a.n);
console.log(`\nlinear fit over ${a.n}->${b.n} feeds: ~${Math.round(a.runtime - perFeed * a.n)} fixed + ~${Math.round(perFeed)} per feed`);
process.exit(0);
