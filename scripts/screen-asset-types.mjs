// Screen the live Lazer catalog for STRUCTURALLY DIVERSE evm updates and save only
// the novel ones as fixtures. Where capture-base-properties.mjs saves consecutive updates
// of one fixed feed set, this explores many feeds across asset types and keeps an
// update only when it differs from what tests/fixtures/captured already holds:
//   new asset class, a missing optional field, a negative/zero price, a new channel,
//   or a different signer.
//
//   LAZER_SCREEN_TARGET=10 node --env-file=.env scripts/screen-asset-types.mjs
//
// Subscribes on fixed_rate@200ms -- the common channel across asset types (most
// non-crypto feeds don't offer real_time) and itself a novelty vs the real_time
// corpus. Saves <=16-feed updates (our decoder's MAX_FEEDS) into
// tests/fixtures/captured/<timestampUs>.json, identical in shape to the API capture.
import { writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { requireToken, createLazerClient, recoverSigner, channelByte, PROD_SIGNER, hexToBytes } from "./lib/lazer.mjs";

const TOKEN = requireToken();

const TARGET = Number(process.env.LAZER_SCREEN_TARGET ?? 10);
const WINDOW = 16; // our decoder's MAX_FEEDS -- a saved update must not exceed this
const CHANNEL = "fixed_rate@200ms";
const PER_WINDOW_MS = Number(process.env.LAZER_SCREEN_WINDOW_MS ?? 12000);
const MAX_WINDOWS = Number(process.env.LAZER_SCREEN_MAX_WINDOWS ?? 40);
const PROPERTIES = ["price", "exponent", "confidence", "bestBidPrice", "bestAskPrice", "publisherCount"];
const OUT_DIR = "tests/fixtures/captured";

const present = (v) => v !== undefined && v !== null;
// Field-presence fingerprint, in [price,exponent,confidence,bestBid,bestAsk,publisherCount] order.
const bitmask = (f) =>
  [f.price, f.exponent, f.confidence, f.bestBidPrice, f.bestAskPrice, f.publisherCount]
    .map((v) => (present(v) ? "1" : "0"))
    .join("");

const client = await createLazerClient(TOKEN);

const symbols = await client.getSymbols();
const idType = new Map(symbols.map((s) => [s.pyth_lazer_id, s.asset_type]));
const idSymbol = new Map(symbols.map((s) => [s.pyth_lazer_id, s.symbol]));

const stableByType = {};
for (const s of symbols) if (s.state === "stable") (stableByType[s.asset_type] ??= []).push(s.pyth_lazer_id);

// The novelty tokens an update contributes. A feed adds its asset class, its
// field-presence fingerprint (per asset class), and any non-positive price sign;
// the message adds its channel byte and signer.
function feedTokens(f) {
  const at = idType.get(f.priceFeedId) ?? "unknown";
  const toks = [`asset:${at}`, `struct:${at}:${bitmask(f)}`];
  if (present(f.price)) {
    const p = BigInt(f.price);
    if (p < 0n) toks.push("sign:neg");
    else if (p === 0n) toks.push("sign:zero");
  }
  return toks;
}
function msgTokens(parsed, channelByte, signer) {
  const t = new Set([`channel:${channelByte}`, `signer:${signer}`]);
  for (const f of parsed.priceFeeds) for (const x of feedTokens(f)) t.add(x);
  return t;
}

// Seed the seen-token set from the corpus already on disk.
const seen = new Set();
if (existsSync(OUT_DIR)) {
  for (const name of readdirSync(OUT_DIR)) {
    if (!name.endsWith(".json")) continue;
    const c = JSON.parse(readFileSync(`${OUT_DIR}/${name}`, "utf8"));
    let signer = "?";
    try { signer = recoverSigner(hexToBytes(c.evmHex)).compressed; } catch { /* leave as ? */ }
    for (const x of msgTokens(c.parsed, c.channel, signer)) seen.add(x);
  }
}
console.log(`seeded ${seen.size} novelty tokens from existing corpus`);

// One window per asset type (chunked to <=16 feeds), crypto last since the corpus
// already covers it; richer asset types first so diversity comes early.
const typeOrder = Object.keys(stableByType).sort((a, b) =>
  a === "crypto" ? 1 : b === "crypto" ? -1 : stableByType[b].length - stableByType[a].length,
);
// Per-type window lists, then interleave round-robin so the first pass hits one
// window of EVERY asset type before any type's second window -- otherwise the
// largest type (equity, ~1800 feeds) monopolizes the run.
const perType = typeOrder.map((t) => {
  const ids = stableByType[t];
  const ws = [];
  for (let i = 0; i < ids.length; i += WINDOW) ws.push({ type: t, ids: ids.slice(i, i + WINDOW) });
  return ws;
});
const total = perType.reduce((n, ws) => n + ws.length, 0);
const windows = [];
for (let i = 0; windows.length < total; i++) {
  for (const ws of perType) if (i < ws.length) windows.push(ws[i]);
}
console.log(`built ${windows.length} windows (interleaved) across asset types: ${typeOrder.join(", ")}`);

let subId = 1000;
function captureWindow(win) {
  return new Promise((resolve) => {
    const id = ++subId;
    let done = false;
    const finishWin = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { client.unsubscribe(id); } catch { /* ignore */ }
      resolve(val);
    };
    const timer = setTimeout(() => finishWin(null), PER_WINDOW_MS);
    client.addMessageListener((event) => {
      if (done || event.type !== "json") return;
      const m = event.value;
      if (m.subscriptionId !== id) return;
      if (m.type === "subscriptionError" || m.type === "error") return finishWin(null);
      if (m.type !== "streamUpdated" || !m.evm?.data || !m.parsed) return;
      finishWin({ evmHex: m.evm.data, parsed: m.parsed });
    });
    client.subscribe({
      type: "subscribe",
      subscriptionId: id,
      priceFeedIds: win.ids,
      properties: PROPERTIES,
      formats: ["evm"],
      jsonBinaryEncoding: "hex",
      parsed: true,
      channel: CHANNEL,
      ignoreInvalidFeedIds: true,
    });
  });
}

mkdirSync(OUT_DIR, { recursive: true });
let saved = 0, tried = 0;
for (const win of windows) {
  if (saved >= TARGET || tried >= MAX_WINDOWS) break;
  tried++;
  const upd = await captureWindow(win);
  if (!upd) { console.log(`[${win.type}] feeds ${win.ids[0]}+: no update within ${PER_WINDOW_MS}ms`); continue; }
  if (upd.parsed.priceFeeds.length > WINDOW) { console.log(`[${win.type}] >${WINDOW} feeds, skip`); continue; }

  const evm = hexToBytes(upd.evmHex);
  const chByte = channelByte(evm);
  const signer = recoverSigner(evm).compressed;
  const toks = msgTokens(upd.parsed, chByte, signer);
  const novel = [...toks].filter((t) => !seen.has(t));
  if (novel.length === 0) { console.log(`[${win.type}] nothing new vs corpus, skip`); continue; }
  for (const t of toks) seen.add(t);

  const ts = upd.parsed.timestampUs;
  writeFileSync(
    `${OUT_DIR}/${ts}.json`,
    JSON.stringify({ channel: chByte, timestampUs: ts, parsed: upd.parsed, evmHex: upd.evmHex }, null, 2) + "\n",
  );
  saved++;

  const negs = upd.parsed.priceFeeds.filter((f) => present(f.price) && BigInt(f.price) < 0n).map((f) => idSymbol.get(f.priceFeedId));
  const missing = upd.parsed.priceFeeds.filter((f) => bitmask(f) !== "111111").map((f) => `${idSymbol.get(f.priceFeedId)}[${bitmask(f)}]`);
  console.log(`SAVED ${saved}/${TARGET} [${win.type}] -> ${ts}.json (${upd.parsed.priceFeeds.length} feeds, channel ${channelByte})`);
  console.log(`   new tokens: ${novel.slice(0, 8).join(", ")}${novel.length > 8 ? ` (+${novel.length - 8} more)` : ""}`);
  if (negs.length) console.log(`   NEGATIVE price: ${negs.join(", ")}`);
  if (missing.length) console.log(`   missing fields [px,exp,conf,bid,ask,pub]: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? " ..." : ""}`);
  if (signer !== PROD_SIGNER) console.log(`   !! DIFFERENT SIGNER: 0x${signer}`);
}

console.log(`\nScreened ${tried} windows; saved ${saved} novel fixtures into ${OUT_DIR}/.`);
process.exit(0);
