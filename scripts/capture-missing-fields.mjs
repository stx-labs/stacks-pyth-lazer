// Capture REAL Pyth Lazer `evm` updates whose feeds OMIT a base property, to prove the decoder
// keeps such feeds (decoding the absent field to `none`) instead of dropping them. Which
// properties a feed carries is subscription-driven, so we simply subscribe WITHOUT price /
// exponent / publisherCount in turn. Run with the access token from .env (never log it):
//
//   node --env-file=.env scripts/capture-missing-fields.mjs
//
// Output: one { channel, timestampUs, parsed, evmHex } file per scenario in OUT_DIR
// (default tests/fixtures/captured/), named `missing-<field>-<timestampUs>.json`.
import { writeFileSync, mkdirSync } from "node:fs";
import { requireToken, createLazerClient, hexToBytes, recoverSigner, channelByte } from "./lib/lazer.mjs";

const TOKEN = requireToken();
const OUT_DIR = process.env.OUT_DIR ?? "tests/fixtures/captured";
// Our key is entitled to >=1000ms channels only (real_time is rate-limited).
const CHANNEL = "fixed_rate@1000ms";
const FEEDS = [1, 2, 6]; // BTC/ETH/SOL: crypto is 24/7, so price/publisherCount are always live

// Each scenario drops exactly one of the three fields from the requested property set.
const SCENARIOS = [
  { tag: "missing-price", properties: ["exponent", "publisherCount", "confidence"] },
  { tag: "missing-exponent", properties: ["price", "publisherCount", "confidence"] },
  { tag: "missing-publisher-count", properties: ["price", "exponent", "confidence"] },
];

const client = await createLazerClient(TOKEN);
mkdirSync(OUT_DIR, { recursive: true });

const byId = new Map(SCENARIOS.map((s, i) => [i + 1, s])); // subscriptionId -> scenario
const captured = new Map(); // subscriptionId -> update (first seen)

function saveAndReport(sub, u) {
  const feed0 = u.parsed?.priceFeeds?.[0] ?? {};
  const present = Object.keys(feed0).filter((k) => k !== "priceFeedId");
  const evm = hexToBytes(u.evmHex.replace(/^0x/, ""));
  const { compressed } = recoverSigner(evm);
  const file = `${OUT_DIR}/${sub.tag}-${u.timestampUs}.json`;
  writeFileSync(file, JSON.stringify({ channel: channelByte(evm), timestampUs: u.timestampUs, parsed: u.parsed, evmHex: u.evmHex }, null, 2) + "\n");
  console.log(`${sub.tag}: wrote ${file}`);
  console.log(`  requested: [${sub.properties.join(", ")}]`);
  console.log(`  feed[0] present fields: [${present.join(", ")}]  feeds: ${u.parsed?.priceFeeds?.length}  signer: 0x${compressed.slice(0, 12)}...`);
}

function finish() {
  if (finish.called) return;
  finish.called = true;
  for (const [id, sub] of byId) if (!captured.has(id)) console.log(`${sub.tag}: FAILED -- no update received`);
  client.shutdown();
  process.exit(0);
}

client.addMessageListener((event) => {
  if (event.type !== "json") return;
  const msg = event.value;
  if (msg.type === "error" || msg.type === "subscriptionError") { console.error("server error:", JSON.stringify(msg.error)); return; }
  if (msg.type !== "streamUpdated") return;
  const id = msg.subscriptionId;
  if (captured.has(id) || !byId.has(id)) return;
  if (!msg.evm?.data || !msg.parsed?.timestampUs) return;
  captured.set(id, true);
  saveAndReport(byId.get(id), { timestampUs: msg.parsed.timestampUs, parsed: msg.parsed, evmHex: msg.evm.data });
  try { client.unsubscribe(id); } catch {}
  if (captured.size === byId.size) finish();
});

for (const [id, sub] of byId) {
  client.subscribe({
    type: "subscribe", subscriptionId: id, priceFeedIds: FEEDS,
    properties: sub.properties, formats: ["evm"], jsonBinaryEncoding: "hex", parsed: true,
    channel: CHANNEL, ignoreInvalidFeedIds: true,
  });
}

setTimeout(finish, 30_000);
