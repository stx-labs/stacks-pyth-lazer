// Capture the LARGEST real Pyth Lazer `evm` update we can, to exercise the raised
// MAX_FEEDS on production bytes. Subscribes to up to MAX_FEEDS crypto feeds (real_time,
// which ticks 24/7 so they arrive together) and keeps the update carrying the most feeds
// that still fits the on-chain limits (<= MAX_FEEDS feeds, <= 8192-byte update).
//
//   node --env-file=.env scripts/capture-max-feeds.mjs
//
// Output: tests/fixtures/captured/<timestampUs>.json (same shape as the other captures).
import { writeFileSync, mkdirSync } from "node:fs";
import { requireToken, createLazerClient, recoverSigner, hasEvmMagic, channelByte, hexToBytes } from "./lib/lazer.mjs";

const TOKEN = requireToken();
const MAX_FEEDS = 75; // must match the decoder; an update over this would be rejected
const BUFFER_BYTES = 8192; // decoder `update` buff bound
const PROPERTIES = ["price", "exponent", "confidence", "bestBidPrice", "bestAskPrice", "publisherCount"];
// Our key is entitled to >=1000ms channels; this is the slowest/broadest fixed rate.
const CHANNEL = "fixed_rate@1000ms";
const OUT_DIR = "tests/fixtures/captured";
const COLLECT_MS = 6000;

const client = await createLazerClient(TOKEN);
const symbols = await client.getSymbols();
// Only stable crypto feeds (crypto trades 24/7, so all tick together; skip inactive ones).
const cryptoIds = symbols.filter((s) => s.asset_type === "crypto" && s.state === "stable").map((s) => s.pyth_lazer_id);
const feedIds = cryptoIds.slice(0, MAX_FEEDS);
console.log(`catalog: ${symbols.length} feeds, ${cryptoIds.length} stable crypto; subscribing to ${feedIds.length}`);

let best = null; // update with the most feeds seen so far (within limits)

function finish() {
  if (finish.called) return;
  finish.called = true;
  if (!best) {
    console.error("no valid update captured");
    client.shutdown();
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const evm = hexToBytes(best.evmHex.replace(/^0x/, ""));
  const file = `${OUT_DIR}/${best.timestampUs}.json`;
  writeFileSync(file, JSON.stringify({
    channel: channelByte(evm), // on-chain Channel enum, read from the signed payload
    timestampUs: best.timestampUs,
    parsed: best.parsed,
    evmHex: best.evmHex,
  }, null, 2) + "\n");
  const { compressed } = recoverSigner(evm);
  console.log(`\nsaved ${file}`);
  console.log(`  feeds: ${best.parsed.priceFeeds.length}  update bytes: ${evm.length}  magic: ${hasEvmMagic(evm) ? "OK" : "BAD"}`);
  console.log(`  signer: 0x${compressed}  (PROD ${compressed === "03a4380f01136eb2640f90c17e1e319e02bbafbeef2e6e67dc48af53f9827e155b" ? "match" : "MISMATCH"})`);
  client.shutdown();
  process.exit(0);
}

client.addMessageListener((event) => {
  if (event.type !== "json") return;
  const msg = event.value;
  if (msg.type === "subscribed") { console.log(`subscribed (id ${msg.subscriptionId})`); return; }
  if (msg.type === "subscribedWithInvalidFeedIdsIgnored") { console.log(`subscribed; ${msg.ignoredInvalidFeedIds?.length ?? 0} ignored`); return; }
  if (msg.type === "error" || msg.type === "subscriptionError") { console.error("server error:", msg.error); return; }
  if (msg.type !== "streamUpdated") return;
  const n = msg.parsed?.priceFeeds?.length ?? 0;
  const bytes = msg.evm?.data ? hexToBytes(msg.evm.data.replace(/^0x/, "")).length : Infinity;
  if (n === 0 || n > MAX_FEEDS || bytes > BUFFER_BYTES) return;
  if (!best || n > best.parsed.priceFeeds.length) {
    best = { timestampUs: msg.parsed.timestampUs, parsed: msg.parsed, evmHex: msg.evm.data, bytes };
    console.log(`  candidate: ${n} feeds, ${bytes} bytes (ts ${best.timestampUs})`);
  }
});

client.subscribe({
  type: "subscribe",
  subscriptionId: 1,
  priceFeedIds: feedIds,
  properties: PROPERTIES,
  formats: ["evm"],
  jsonBinaryEncoding: "hex",
  parsed: true,
  channel: CHANNEL,
  ignoreInvalidFeedIds: true,
});

setTimeout(finish, COLLECT_MS);
