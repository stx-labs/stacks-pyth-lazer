// Capture REAL Pyth Lazer `evm` updates that exercise the EXTENDED properties, saved
// as golden fixtures under tests/fixtures/captured/<ts>.json. The v1 decoder handles
// the full property set (0-12), so every captured update must decode to Pyth's own
// SDK parse -- verified by the "captured" runner in fixtures.test.ts.
//
// Three feed groups give the extended props real, non-zero values on fixed_rate@1000ms
// (channel byte 4):
//   crypto        market-session (regular=0), ema-price/ema-confidence, feed-update-timestamp
//   funding-rate  funding-rate/timestamp/interval present (incl. negative rates); no conf/bid/ask/ema
//   equity        market-session != regular (closed=4, the enum's upper bound the decoder accepts)
//
//   node --env-file=.env scripts/capture-extended-properties.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { requireToken, createLazerClient, recoverSigner, channelByte, PROD_SIGNER, hexToBytes } from "./lib/lazer.mjs";

const TOKEN = requireToken();
const CHANNEL = "fixed_rate@1000ms";
const OUT_DIR = process.env.CAPTURE_OUT_DIR ?? "tests/fixtures/captured";
const PROPS = ["price", "bestBidPrice", "bestAskPrice", "publisherCount", "exponent", "confidence",
  "fundingRate", "fundingTimestamp", "fundingRateInterval", "marketSession", "emaPrice", "emaConfidence", "feedUpdateTimestamp"];

// property type widths (verified against PythLazerLib.sol + live bytes)
const W8 = new Set([0, 1, 2, 5, 10, 11]), W2 = new Set([3, 4, 9]), EXIST = new Set([6, 7, 8, 12]);
const be = (b, o, n) => { let v = 0n; for (let i = 0; i < n; i++) v = (v << 8n) | BigInt(b[o + i]); return v; };

// Walk the evm payload; return per-feed present {type: value|null} + a cursor-exactness flag.
// (existence-flagged types carry null when their flag byte is 0.)
function walk(evm) {
  const len = (evm[69] << 8) | evm[70], p0 = 71, end = p0 + len;
  const channel = channelByte(evm), feedsLen = evm[p0 + 13];
  let off = p0 + 14;
  const feeds = [];
  for (let fi = 0; fi < feedsLen; fi++) {
    const feedId = Number(be(evm, off, 4)); off += 4;
    const nProps = evm[off]; off += 1;
    const vals = {};
    for (let pi = 0; pi < nProps; pi++) {
      const t = evm[off]; off += 1;
      if (W8.has(t)) { vals[t] = be(evm, off, 8); off += 8; }
      else if (W2.has(t)) { vals[t] = be(evm, off, 2); off += 2; }
      else if (EXIST.has(t)) { const f = evm[off]; off += 1; if (f !== 0) { vals[t] = be(evm, off, 8); off += 8; } else vals[t] = null; }
      else return { ok: false, reason: `unknown type ${t}` };
    }
    feeds.push({ feedId, vals });
  }
  return { ok: off === end, channel, feeds };
}

// A saved feed must not carry a raw 0 in a field the on-chain runner does NOT treat as a
// sentinel (price/confidence/publisher-count/bid/ask); the SDK omits sentinel-0s, so a
// literal 0 here would make expected (some 0) != decoded (none). Also reject market-session
// past the decoder's 0-4 bound (it would fail-closed) -- real data tops out at 4.
const SENTINEL_SAFE = (f) =>
  [f.price, f.confidence, f.publisherCount, f.bestBidPrice, f.bestAskPrice].every((v) => v == null || BigInt(v) !== 0n);
const sessionOk = (w) => w.feeds.every((f) => f.vals[9] === undefined || f.vals[9] <= 4n);

const client = await createLazerClient(TOKEN);
const symbols = await client.getSymbols();
const idSym = new Map(symbols.map((s) => [s.pyth_lazer_id, s.symbol]));
const stable = (type) => symbols.filter((s) => s.asset_type === type && s.state === "stable").map((s) => s.pyth_lazer_id);

let subId = 1;
// Collect `count` updates with DISTINCT publish-times, spaced >= staggerMs apart.
function collect({ feeds, count, staggerMs, label }) {
  return new Promise((resolve) => {
    const id = subId++;
    const out = [], seenTs = new Set();
    let lastMs = 0, subErr = null;
    const listener = (event) => {
      if (event.type !== "json") return;
      const m = event.value;
      if (m.subscriptionId !== id) return;
      if (m.type === "subscriptionError" || m.type === "error") { subErr = m.error; return; }
      if (m.type !== "streamUpdated" || !m.evm?.data) return;
      const ts = m.parsed?.timestampUs, now = Date.now();
      if (seenTs.has(ts) || (out.length > 0 && now - lastMs < staggerMs)) return;
      seenTs.add(ts); lastMs = now;
      out.push({ evmHex: m.evm.data, parsed: m.parsed });
      console.log(`  [${label}] ${out.length}/${count} ts=${ts}`);
      if (out.length >= count) finish();
    };
    const finish = () => { try { client.unsubscribe(id); } catch {} clearTimeout(timer); resolve({ out, subErr }); };
    const timer = setTimeout(finish, staggerMs * count + 30000);
    client.addMessageListener(listener);
    client.subscribe({ type: "subscribe", subscriptionId: id, priceFeedIds: feeds.slice(0, 16),
      properties: PROPS, formats: ["evm"], jsonBinaryEncoding: "hex", parsed: true, channel: CHANNEL, ignoreInvalidFeedIds: true });
  });
}

mkdirSync(OUT_DIR, { recursive: true });
let signerWarn = false;

// Save updates from one group; `carries` (optional) requires a target property to be present
// (e.g. a funding value) so the fixture actually adds the coverage the group is meant to.
async function capture({ type, feeds, count, staggerMs, carries }) {
  console.log(`Group ${type}: ${feeds.length} stable feeds`);
  const r = await collect({ feeds, count, staggerMs, label: type });
  if (r.subErr) console.log(`  subscriptionError: ${JSON.stringify(r.subErr)}`);
  let saved = 0;
  for (const u of r.out) {
    const evm = hexToBytes(u.evmHex);
    const w = walk(evm);
    if (!w.ok) { console.log(`  skip ${u.parsed.timestampUs}: walk not exact (${w.reason ?? "cursor"})`); continue; }
    if (!sessionOk(w)) { console.log(`  skip ${u.parsed.timestampUs}: market-session > 4`); continue; }
    if (u.parsed.priceFeeds.some((f) => !SENTINEL_SAFE(f))) { console.log(`  skip ${u.parsed.timestampUs}: sentinel-zero field would mismatch`); continue; }
    if (carries && !w.feeds.some((f) => carries.some((t) => f.vals[t] != null))) { console.log(`  skip ${u.parsed.timestampUs}: no ${type} value present`); continue; }
    const signer = recoverSigner(evm).compressed;
    if (signer !== PROD_SIGNER) { console.log(`  !! signer 0x${signer} != known prod`); signerWarn = true; }
    writeFileSync(`${OUT_DIR}/${u.parsed.timestampUs}.json`,
      JSON.stringify({ channel: w.channel, timestampUs: u.parsed.timestampUs, parsed: u.parsed, evmHex: u.evmHex }, null, 2) + "\n");
    saved++;
  }
  console.log(`  saved ${saved}`);
  return saved;
}

// crypto: curated majors + redemption-rate/index/nav for variety (ema, market-session=regular).
const a = await capture({ type: "crypto", feeds: [1, 2, 6, 673, 3065, 1575, 1831], count: 3, staggerMs: 2000 });
// funding-rate: the only feeds that carry present funding (6/7/8), incl. negative rates.
const b = await capture({ type: "funding-rate", feeds: stable("funding-rate"), count: 2, staggerMs: 2000, carries: [6, 7, 8] });
// equity: market-session != regular (closed=4); also a full 16-feed update.
const c = await capture({ type: "equity", feeds: stable("equity"), count: 2, staggerMs: 2000 });

console.log(`\nDONE: ${a + b + c} new/updated fixtures in ${OUT_DIR}/ (crypto ${a}, funding ${b}, equity ${c}).`);
if (signerWarn) console.log("WARNING: some updates were not signed by the known production key.");
client.shutdown();
process.exit(0);
