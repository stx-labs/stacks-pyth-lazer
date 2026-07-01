// Capture REAL Pyth Lazer `evm` updates that exercise the extended properties, saved
// as golden fixtures. Two groups:
//
//   tests/fixtures/captured/<ts>.json         DECODABLE: requests only decoder-supported
//       properties (price/bid/ask/pub/exp/conf + marketSession(9)/emaPrice(10)/emaConfidence(11)).
//       These must decode to Pyth's parse -- the fixtures.test.ts "captured" runner.
//
//   tests/fixtures/captured-reject/<ts>.json   MUST-REJECT: also requests the variable-length
//       existence-byte properties (fundingRate(6)/fundingTimestamp(7)/fundingRateInterval(8)
//       and feedUpdateTimestamp(12)). Our decoder fails closed on these -> ERR_UNKNOWN_PROPERTY.
//
// The current key is entitled to crypto-family feeds only (fixed_rate@1000ms), where
// market-session is always `regular` (0) and funding is always ABSENT (existence flag 0);
// those gaps are covered elsewhere. Run:
//
//   node --env-file=.env scripts/capture-extended-properties.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import WebSocket from "ws";
import { requireToken, recoverSigner, channelByte, PROD_SIGNER, authedWsUrl, WS_URLS, hexToBytes } from "./lib/lazer.mjs";

const TOKEN = requireToken();

const CHANNEL = "fixed_rate@1000ms"; // channel byte 4; the only tier this key allows
const ERR_UNKNOWN_PROPERTY = 2205;
const DEC_DIR = "tests/fixtures/captured";
const REJ_DIR = "tests/fixtures/captured-reject";

// Entitled crypto-family feeds with rich data (spot carry bid/ask/ema; RR/index/nav add variety).
const CRYPTO_FEEDS = [1, 2, 6, 673, 3065, 1575, 1831];
const SUPPORTED = ["price", "bestBidPrice", "bestAskPrice", "publisherCount", "exponent", "confidence", "marketSession", "emaPrice", "emaConfidence"];
const REJECT_FUNDING = ["price", "exponent", "publisherCount", "fundingRate", "fundingTimestamp", "fundingRateInterval", "feedUpdateTimestamp"];
const REJECT_UPDTS = ["price", "exponent", "publisherCount", "feedUpdateTimestamp"];

// property type widths (verified against PythLazerLib.sol + live bytes)
const W8 = new Set([0, 1, 2, 5, 10, 11]), W2 = new Set([3, 4, 9]), EXIST = new Set([6, 7, 8, 12]);
const SUPPORTED_TYPES = new Set([0, 1, 2, 3, 4, 5, 9, 10, 11]);
const REJECT_TYPES = new Set([6, 7, 8, 12]);

const be = (b, o, n) => { let v = 0n; for (let i = 0; i < n; i++) v = (v << 8n) | BigInt(b[o + i]); return v; };

// Walk the evm payload; return per-feed present property types + a cursor-exactness flag.
function walk(evm) {
  const len = (evm[69] << 8) | evm[70], p0 = 71, end = p0 + len;
  const channel = channelByte(evm), feedsLen = evm[p0 + 13];
  let off = p0 + 14;
  const feeds = [];
  for (let fi = 0; fi < feedsLen; fi++) {
    const feedId = Number(be(evm, off, 4)); off += 4;
    const nProps = evm[off]; off += 1;
    const types = [];
    for (let pi = 0; pi < nProps; pi++) {
      const t = evm[off]; off += 1;
      let w;
      if (W8.has(t)) w = 8;
      else if (W2.has(t)) w = 2;
      else if (EXIST.has(t)) w = evm[off] !== 0 ? 9 : 1;
      else return { ok: false, reason: `unknown type ${t}` };
      off += w;
      types.push(t);
    }
    feeds.push({ feedId, types });
  }
  return { ok: off === end, channel, feedsLen, feeds };
}

// A decodable feed must not carry a raw 0 in a field the on-chain runner does not treat
// as a sentinel (price/confidence/publisher-count/bid/ask), else expected != decoded.
const SENTINEL_SAFE = (f) =>
  [f.price, f.confidence, f.publisherCount, f.bestBidPrice, f.bestAskPrice]
    .every((v) => v === undefined || v === null || BigInt(v) !== 0n);

const ws = new WebSocket(authedWsUrl(WS_URLS[0], TOKEN));
await new Promise((res, rej) => {
  ws.on("open", res);
  ws.on("error", (e) => rej(new Error(String(e?.message ?? e))));
  ws.on("unexpected-response", (_q, r) => rej(new Error(`handshake HTTP ${r.statusCode}`)));
});
const listeners = new Set();
ws.on("message", (data) => { let m; try { m = JSON.parse(data.toString()); } catch { return; } for (const l of listeners) l(m); });

let subId = 1;
// Collect `count` updates with DISTINCT publish-times, spaced >= staggerMs apart.
function collect({ feeds, props, count, staggerMs, label }) {
  return new Promise((resolve) => {
    const id = subId++;
    const out = [], seenTs = new Set();
    let lastMs = 0, subErr = null;
    const listener = (m) => {
      if (m.type === "subscriptionError" || (m.type === "error" && m.subscriptionId === id)) { subErr = m.error; return; }
      if (m.subscriptionId !== id || m.type !== "streamUpdated" || !m.evm?.data) return;
      const ts = m.parsed?.timestampUs, now = Date.now();
      if (seenTs.has(ts) || (out.length > 0 && now - lastMs < staggerMs)) return;
      seenTs.add(ts); lastMs = now;
      out.push({ evmHex: m.evm.data, parsed: m.parsed });
      console.log(`  [${label}] ${out.length}/${count} ts=${ts}`);
      if (out.length >= count) finish();
    };
    const finish = () => { listeners.delete(listener); try { ws.send(JSON.stringify({ type: "unsubscribe", subscriptionId: id })); } catch {} clearTimeout(timer); resolve({ out, subErr }); };
    const timer = setTimeout(finish, staggerMs * count + 30000);
    listeners.add(listener);
    ws.send(JSON.stringify({ type: "subscribe", subscriptionId: id, priceFeedIds: feeds, properties: props, formats: ["evm"], jsonBinaryEncoding: "hex", parsed: true, channel: CHANNEL, ignoreInvalidFeedIds: true }));
  });
}

mkdirSync(DEC_DIR, { recursive: true });
mkdirSync(REJ_DIR, { recursive: true });
let signerWarn = false;
const checkSigner = (evm) => { const s = recoverSigner(evm).compressed; if (s !== PROD_SIGNER) { console.log(`  !! signer 0x${s} != known prod`); signerWarn = true; } };

console.log("Group A: decodable (supported props incl. marketSession/emaPrice/emaConfidence)");
const A = await collect({ feeds: CRYPTO_FEEDS, props: SUPPORTED, count: 8, staggerMs: 2000, label: "decodable" });
let decSaved = 0;
for (const u of A.out) {
  const evm = hexToBytes(u.evmHex);
  const w = walk(evm);
  const badType = w.ok && w.feeds.some((f) => f.types.some((t) => !SUPPORTED_TYPES.has(t)));
  const badZero = u.parsed.priceFeeds.some((f) => !SENTINEL_SAFE(f));
  if (!w.ok) { console.log(`  skip ${u.parsed.timestampUs}: walk not exact (${w.reason ?? "cursor"})`); continue; }
  if (badType) { console.log(`  skip ${u.parsed.timestampUs}: carries a non-supported property type`); continue; }
  if (badZero) { console.log(`  skip ${u.parsed.timestampUs}: sentinel-zero field would mismatch`); continue; }
  checkSigner(evm);
  writeFileSync(`${DEC_DIR}/${u.parsed.timestampUs}.json`,
    JSON.stringify({ channel: w.channel, timestampUs: u.parsed.timestampUs, parsed: u.parsed, evmHex: u.evmHex }, null, 2) + "\n");
  decSaved++;
}
console.log(`  saved ${decSaved} decodable fixtures`);

async function saveReject(props, count, tag, desc) {
  const r = await collect({ feeds: [1, 2, 6], props, count, staggerMs: 2000, label: tag });
  let n = 0;
  for (const u of r.out) {
    const evm = hexToBytes(u.evmHex);
    const w = walk(evm);
    const carries = w.ok && w.feeds.some((f) => f.types.some((t) => REJECT_TYPES.has(t)));
    if (!carries) { console.log(`  skip ${u.parsed.timestampUs}: no rejected property present`); continue; }
    checkSigner(evm);
    const present = [...new Set(w.feeds.flatMap((f) => f.types).filter((t) => REJECT_TYPES.has(t)))].sort((a, b) => a - b);
    writeFileSync(`${REJ_DIR}/${u.parsed.timestampUs}.json`,
      JSON.stringify({ description: desc, expectErr: ERR_UNKNOWN_PROPERTY, rejectedTypesPresent: present, channel: w.channel, timestampUs: u.parsed.timestampUs, parsed: u.parsed, evmHex: u.evmHex }, null, 2) + "\n");
    n++;
  }
  return n;
}

console.log("Group B1: must-reject (funding 6/7/8 + feed-update-timestamp 12)");
const b1 = await saveReject(REJECT_FUNDING, 3, "reject-funding", "real update carrying funding (6/7/8, absent) + feed-update-timestamp (12); decoder fails closed");
console.log("Group B2: must-reject (feed-update-timestamp 12 only)");
const b2 = await saveReject(REJECT_UPDTS, 2, "reject-updts", "real update carrying feed-update-timestamp (12); decoder fails closed");
console.log(`  saved ${b1 + b2} reject fixtures`);

console.log(`\nDONE: ${decSaved} decodable + ${b1 + b2} reject = ${decSaved + b1 + b2} new fixtures.`);
if (signerWarn) console.log("WARNING: some updates were not signed by the known production key.");
ws.close();
process.exit(0);
