// Capture REAL Pyth Lazer `evm` updates from the live API and save them as golden
// fixtures. Run with the access token from .env (never hard-code or log it):
//
//   node --env-file=.env scripts/gen-lazer-fixture.mjs
//
// Output:
//   tests/fixtures/lazer/captured-updates.json   raw evm hex + Pyth's parsed values
// Console:
//   - per-property presence summary (the schema-finalization signal: which of
//     price/exponent/confidence/bestBid/bestAsk/publisherCount Pyth ALWAYS sends)
//   - the recovered PRODUCTION signer compressed pubkey (the Phase 6 governance seed)
//
// The captured fixtures contain only public price data + signatures -- no token.
import { writeFileSync, mkdirSync } from "node:fs";
import { PythLazerClient } from "@pythnetwork/pyth-lazer-sdk";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils";

const TOKEN = process.env.PYTH_API_KEY;
if (!TOKEN) {
  console.error("PYTH_API_KEY not set. Run: node --env-file=.env scripts/gen-lazer-fixture.mjs");
  process.exit(1);
}

const FEEDS = { 1: "Crypto.BTC/USD", 2: "Crypto.ETH/USD", 6: "Crypto.SOL/USD" };
const PROPERTIES = ["price", "exponent", "confidence", "bestBidPrice", "bestAskPrice", "publisherCount"];
const CHANNEL = "real_time";
const TARGET_UPDATES = 8;
const TIMEOUT_MS = 30_000;
const OUT_DIR = "tests/fixtures/lazer";

// Recover the secp256k1 signer of one `evm` update (magic|r|s|recid|len|payload).
// Returns the 33-byte compressed pubkey our governance keys on, or null if the
// envelope is not the single-signature evm shape we expect.
function recoverSigner(evmHex) {
  const u = hexToBytes(evmHex.replace(/^0x/, ""));
  const magic = (u[0] << 24) | (u[1] << 16) | (u[2] << 8) | u[3];
  if ((magic >>> 0) !== 0x2a22999a) return { error: `unexpected magic 0x${(magic >>> 0).toString(16)}` };
  const r = u.slice(4, 36), s = u.slice(36, 68), recid = u[68];
  const payloadLen = (u[69] << 8) | u[70];
  const payload = u.slice(71, 71 + payloadLen);
  const sig = secp256k1.Signature.fromCompact(bytesToHex(r) + bytesToHex(s)).addRecoveryBit(recid);
  const pub = sig.recoverPublicKey(keccak_256(payload));
  const ethAddr = bytesToHex(keccak_256(pub.toRawBytes(false).slice(1)).slice(12));
  return { compressed: bytesToHex(pub.toRawBytes(true)), ethAddr, payloadLen, magicOk: true };
}

const client = await PythLazerClient.create({
  token: TOKEN,
  webSocketPoolConfig: {
    urls: [
      "wss://pyth-lazer-0.dourolabs.app/v1/stream",
      "wss://pyth-lazer-1.dourolabs.app/v1/stream",
      "wss://pyth-lazer-2.dourolabs.app/v1/stream",
    ],
  },
});

const captured = [];
const done = () => {
  finish();
};

function finish() {
  if (finish.called) return;
  finish.called = true;

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/captured-updates.json`, JSON.stringify({
    feeds: FEEDS, properties: PROPERTIES, channel: CHANNEL,
    capturedAtNote: "real Pyth Lazer evm updates; values are public market data",
    updates: captured,
  }, null, 2) + "\n");

  console.log(`\nCaptured ${captured.length} updates -> ${OUT_DIR}/captured-updates.json`);

  // Property-presence summary: for each (feed, property), how often it was present.
  const seen = {};
  let feedRows = 0;
  for (const up of captured) {
    for (const f of up.parsed?.priceFeeds ?? []) {
      feedRows++;
      seen[f.priceFeedId] ??= { _n: 0 };
      seen[f.priceFeedId]._n++;
      for (const p of PROPERTIES) if (f[p] !== undefined && f[p] !== null) seen[f.priceFeedId][p] = (seen[f.priceFeedId][p] ?? 0) + 1;
    }
  }
  console.log(`\nProperty presence (count present / ${"feed-rows"}):`);
  for (const [id, rec] of Object.entries(seen)) {
    const n = rec._n;
    const line = PROPERTIES.map((p) => `${p}:${rec[p] ?? 0}/${n}${(rec[p] ?? 0) === n ? "" : " !"}`).join("  ");
    console.log(`  feed ${id} ${FEEDS[id] ?? ""} (${n} rows)\n    ${line}`);
  }

  // Recover the production signer from the first evm update.
  const firstEvm = captured.find((u) => u.evmHex)?.evmHex;
  if (firstEvm) {
    const r = recoverSigner(firstEvm);
    console.log("\nProduction signer (from real update):");
    console.log(`  evm prefix: ${firstEvm.replace(/^0x/, "").slice(0, 8)}  ${r.magicOk ? "(evm magic OK)" : "!! " + r.error}`);
    if (r.compressed) {
      console.log(`  compressed pubkey: 0x${r.compressed}`);
      console.log(`  eth address:       0x${r.ethAddr}`);
    }
  }

  client.shutdown();
  process.exit(0);
}

client.addMessageListener((event) => {
  if (event.type !== "json") return;
  const msg = event.value;
  if (msg.type === "subscribed") { console.log(`subscribed (id ${msg.subscriptionId})`); return; }
  if (msg.type === "subscribedWithInvalidFeedIdsIgnored") { console.log("subscribed; ignored:", msg.ignoredInvalidFeedIds); return; }
  if (msg.type === "error" || msg.type === "subscriptionError") { console.error("server error:", msg.error); return; }
  if (msg.type !== "streamUpdated") return;
  captured.push({
    seq: captured.length + 1,
    timestampUs: msg.parsed?.timestampUs,
    parsed: msg.parsed,
    evmHex: msg.evm?.data,
  });
  process.stdout.write(`\rcaptured ${captured.length}/${TARGET_UPDATES}`);
  if (captured.length >= TARGET_UPDATES) done();
});

client.subscribe({
  type: "subscribe",
  subscriptionId: 1,
  priceFeedIds: Object.keys(FEEDS).map(Number),
  properties: PROPERTIES,
  formats: ["evm"],
  jsonBinaryEncoding: "hex",
  parsed: true,
  channel: CHANNEL,
  ignoreInvalidFeedIds: true,
});

setTimeout(() => {
  console.log("\ntimeout reached");
  finish();
}, TIMEOUT_MS);
