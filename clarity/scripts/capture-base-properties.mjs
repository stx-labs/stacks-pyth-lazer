// Capture REAL Pyth Lazer `evm` updates from the live API and save them as golden
// fixtures. Run with the access token from .env (never hard-code or log it):
//
//   node --env-file=.env scripts/capture-base-properties.mjs
//
// Capture more, spaced out (one roughly every 90s) for temporal spread:
//
//   LAZER_CAPTURE_COUNT=12 LAZER_CAPTURE_STAGGER_MS=90000 \
//     node --env-file=.env scripts/capture-base-properties.mjs
//
// Output:
//   tests/fixtures/captured/<timestampUs>.json   one file per update (raw evm hex +
//                                                 Pyth's parsed values); re-running
//                                                 adds new timestamps, keeps existing
// Console:
//   - per-property presence summary (the schema-finalization signal: which of
//     price/exponent/confidence/bestBid/bestAsk/publisherCount Pyth ALWAYS sends)
//   - the recovered PRODUCTION signer compressed pubkey (the Phase 6 governance seed)
//
// The captured fixtures contain only public price data + signatures -- no token.
import { writeFileSync, mkdirSync } from "node:fs";
import { requireToken, createLazerClient, recoverSigner, hasEvmMagic, hexToBytes } from "./lib/lazer.mjs";

const TOKEN = requireToken();

const FEEDS = { 1: "Crypto.BTC/USD", 2: "Crypto.ETH/USD", 6: "Crypto.SOL/USD" };
const PROPERTIES = ["price", "exponent", "confidence", "bestBidPrice", "bestAskPrice", "publisherCount"];
const CHANNEL = "real_time";
const CHANNEL_NUM = { real_time: 1 }[CHANNEL]; // on-chain Channel enum value
// How many updates to capture and how far to space them. The real_time stream
// emits ~20x/sec; STAGGER_MS samples at most one update per interval for temporal
// spread (0 = take them consecutively). Both overridable via env.
const TARGET_UPDATES = Number(process.env.LAZER_CAPTURE_COUNT ?? 8);
const STAGGER_MS = Number(process.env.LAZER_CAPTURE_STAGGER_MS ?? 0);
const OUT_DIR = "tests/fixtures/captured";
// Enough wall-clock for the whole staggered run (the first update is immediate) + buffer.
const TIMEOUT_MS = TARGET_UPDATES * STAGGER_MS + 60_000;

const client = await createLazerClient(TOKEN);

const captured = [];
let lastCaptureMs = 0;
const done = () => {
  finish();
};

function finish() {
  if (finish.called) return;
  finish.called = true;

  if (CHANNEL_NUM === undefined) throw new Error(`unmapped channel: ${CHANNEL}`);
  mkdirSync(OUT_DIR, { recursive: true });
  // One self-contained file per update, named by publish-time. Re-running adds new
  // timestamps and overwrites a same-timestamp recapture; it never deletes others.
  for (const u of captured) {
    writeFileSync(`${OUT_DIR}/${u.timestampUs}.json`, JSON.stringify({
      channel: CHANNEL_NUM,
      timestampUs: u.timestampUs,
      parsed: u.parsed,
      evmHex: u.evmHex,
    }, null, 2) + "\n");
  }

  console.log(`\nCaptured ${captured.length} updates -> ${OUT_DIR}/<timestampUs>.json (one file each)`);

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
    const evm = hexToBytes(firstEvm.replace(/^0x/, ""));
    const { compressed, ethAddr } = recoverSigner(evm);
    console.log("\nProduction signer (from real update):");
    console.log(`  evm prefix: ${firstEvm.replace(/^0x/, "").slice(0, 8)}  ${hasEvmMagic(evm) ? "(evm magic OK)" : "!! unexpected magic"}`);
    console.log(`  compressed pubkey: 0x${compressed}`);
    console.log(`  eth address:       0x${ethAddr}`);
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
  const nowMs = Date.now();
  // Sample at most one update per STAGGER_MS window; the first is captured immediately.
  if (captured.length > 0 && nowMs - lastCaptureMs < STAGGER_MS) return;
  lastCaptureMs = nowMs;
  captured.push({
    seq: captured.length + 1,
    timestampUs: msg.parsed?.timestampUs,
    parsed: msg.parsed,
    evmHex: msg.evm?.data,
  });
  console.log(`captured ${captured.length}/${TARGET_UPDATES} (ts ${msg.parsed?.timestampUs})`);
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
