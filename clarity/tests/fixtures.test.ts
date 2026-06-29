import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import { hexToBytes } from "@noble/hashes/utils";
import { readdirSync, readFileSync } from "node:fs";
import { buildEvmUpdate, buildLazerPayload, OTHER_PRIVKEY, PROP, TEST_PUBKEY, type FeedSpec } from "./helpers";

// ---------------------------------------------------------------------------
// Data-driven fixture runner. Every file under tests/fixtures/ is a test case;
// add coverage by dropping in a file, no code change needed.
//
//   fixtures/captured/<timestampUs>.json   REAL Lazer `evm` updates from the API
//       { channel, timestampUs, parsed, evmHex } -- evmHex (signed ground truth)
//       must decode to `parsed` (Pyth's own SDK decode). Replayed in publish-time
//       order to exercise storage's monotonic guard.
//
//   fixtures/generated/pass/<name>.json    synthetic specs that MUST decode
//   fixtures/generated/fail/<name>.json    synthetic specs that MUST be rejected
//       { description, channel, timestampUs, feeds: [{ id, props: [[type, dec-str]] }],
//         corrupt?, expectErr? } -- the runner encodes the payload, signs it with the
//       TEST key, and decodes on-chain. `props` type is a PROP name or a raw number
//       (for unknown-type cases); values are decimal strings (big ints / negatives).
//       pass: the decode must equal the spec. fail: it must error with `expectErr`.
//
// captured fixtures are signed by Pyth's PRODUCTION key; generated ones by the
// synthetic TEST key. The runner trusts both, so every category verifies.
// ---------------------------------------------------------------------------

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!; // governance admin
const relayer = accounts.get("wallet_1")!; // submission is permissionless

const ORACLE = "pyth-lazer-oracle-v1";
const GOV = "pyth-lazer-governance";
const STORAGE = "pyth-lazer-storage";
const DECODER = "pyth-lazer-decoder-v1";

const FAR_FUTURE = 100_000_000_000n;
const PROD_SIGNER = "03a4380f01136eb2640f90c17e1e319e02bbafbeef2e6e67dc48af53f9827e155b";
const decoderRef = Cl.contractPrincipal(deployer, DECODER);

type Fixture = { name: string; data: any };

function load(rel: string): Fixture[] {
  let names: string[];
  try {
    names = readdirSync(new URL(`./fixtures/${rel}/`, import.meta.url));
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".json"))
    .sort()
    .map((name) => ({
      name,
      data: JSON.parse(readFileSync(new URL(`./fixtures/${rel}/${name}`, import.meta.url), "utf8")),
    }));
}

const captured = load("captured");
const genPass = load("generated/pass");
const genFail = load("generated/fail");

// Trust both the production signer (captured updates) and the synthetic test
// signer (generated updates), so any fixture's signature verifies.
function trustAll() {
  simnet.callPublicFn(
    GOV,
    "set-trusted-signers",
    [Cl.list([
      Cl.tuple({ pubkey: Cl.buffer(hexToBytes(PROD_SIGNER)), "expires-at": Cl.uint(FAR_FUTURE) }),
      Cl.tuple({ pubkey: Cl.buffer(TEST_PUBKEY), "expires-at": Cl.uint(FAR_FUTURE) }),
    ])],
    deployer,
  );
}

const decode = (update: Uint8Array) =>
  simnet.callReadOnlyFn(DECODER, "decode-and-verify-price-feeds", [Cl.buffer(update)], deployer).result;
const submit = (update: Uint8Array) =>
  simnet.callPublicFn(ORACLE, "verify-and-update-price-feeds", [Cl.buffer(update), decoderRef], relayer).result;
const getPrice = (feedId: number) =>
  simnet.callReadOnlyFn(STORAGE, "get-price", [Cl.uint(feedId)], deployer).result;

const optInt = (v: bigint | null) => (v === null ? Cl.none() : Cl.some(Cl.int(v)));
const optUint = (v: bigint | null) => (v === null ? Cl.none() : Cl.some(Cl.uint(v)));
const big = (v: string | number | null | undefined) => (v === null || v === undefined ? null : BigInt(v));

// === captured: real evm bytes must decode to Pyth's own parsed values ===

// The decoder only emits feeds carrying all required fields; feeds missing one are dropped.
const hasRequired = (f: any) => f.price != null && f.exponent != null && f.publisherCount != null;

const capturedFeed = (f: any) =>
  Cl.tuple({
    "feed-id": Cl.uint(f.priceFeedId),
    price: Cl.int(BigInt(f.price)),
    exponent: Cl.int(BigInt(f.exponent)),
    confidence: optUint(big(f.confidence)),
    "publisher-count": Cl.uint(BigInt(f.publisherCount)),
    "best-bid": optInt(big(f.bestBidPrice)),
    "best-ask": optInt(big(f.bestAskPrice)),
    "ema-price": Cl.none(),
    "ema-confidence": Cl.none(),
    "feed-update-timestamp": Cl.none(),
  });

const capturedDecode = (c: any) =>
  Cl.tuple({
    timestamp: Cl.uint(BigInt(c.parsed.timestampUs)),
    channel: Cl.uint(c.channel),
    "price-feeds": Cl.list(c.parsed.priceFeeds.filter(hasRequired).map(capturedFeed)),
  });

// The stored record = decoder output + oracle-supplied publish-time/channel.
const capturedStored = (f: any, c: any) =>
  Cl.tuple({
    price: Cl.int(BigInt(f.price)),
    exponent: Cl.int(BigInt(f.exponent)),
    "publisher-count": Cl.uint(BigInt(f.publisherCount)),
    confidence: optUint(big(f.confidence)),
    "best-bid": optInt(big(f.bestBidPrice)),
    "best-ask": optInt(big(f.bestAskPrice)),
    "ema-price": Cl.none(),
    "ema-confidence": Cl.none(),
    "feed-update-timestamp": Cl.none(),
    "publish-time": Cl.uint(BigInt(c.timestampUs)),
    channel: Cl.uint(c.channel),
  });

// === generated: build a payload from the spec, then sign with the TEST key ===

const propType = (t: number | string) => (typeof t === "number" ? t : (PROP as Record<string, number>)[t]);
const toFeedSpec = (f: any): FeedSpec => ({
  id: f.id,
  props: f.props.map(([t, v]: [number | string, string]) => [propType(t), BigInt(v)]),
});

// Build the signed update for a spec, optionally applying a `corrupt` directive to
// drive a specific decoder error. Directives are grouped by stage: payload mutations
// happen BEFORE signing (the signature still covers them, so the failure surfaces in
// the payload parser), envelope mutations AFTER signing (they break the outer frame /
// signature), and `untrusted-signer` swaps the signing key for a valid-but-untrusted one.
const KNOWN_CORRUPT = new Set([
  "payload-magic", "trailing-overlay", "truncate-payload", "inflate-feed-count",
  "untrusted-signer", "evm-magic", "envelope-overlay", "bad-signature", "truncate-envelope",
]);
function buildUpdateFromSpec(spec: any): Uint8Array {
  const c: string | undefined = spec.corrupt;
  if (c && !KNOWN_CORRUPT.has(c)) throw new Error(`unknown corrupt directive: ${c}`);

  let payload = buildLazerPayload({
    timestamp: BigInt(spec.timestampUs),
    channel: spec.channel,
    feeds: spec.feeds.map(toFeedSpec),
  });
  // pre-sign payload mutations (signature covers the mutated bytes)
  if (c === "payload-magic") {
    payload = Uint8Array.from(payload);
    payload[0] = 0x00; // wrong Lazer FORMAT_MAGIC -> ERR_INVALID_PAYLOAD_MAGIC (2201)
  } else if (c === "trailing-overlay") {
    payload = Uint8Array.from([...payload, 0xff, 0xff]); // bytes after the last feed -> ERR_PAYLOAD_OVERLAY (2204)
  } else if (c === "truncate-payload") {
    payload = payload.slice(0, payload.length - (spec.corruptBytes ?? 3)); // cut a value short -> ERR_INVALID_FEED_DATA (2203)
  } else if (c === "inflate-feed-count") {
    payload = Uint8Array.from(payload);
    payload[13] += 1; // PAYLOAD_FEEDS_LEN_OFFSET: claim one more feed than present -> ERR_INVALID_FEED_DATA (2203)
  }

  // signing: an untrusted (but valid) signature -> ERR_UNTRUSTED_SIGNER (2105)
  let update = buildEvmUpdate(payload, c === "untrusted-signer" ? OTHER_PRIVKEY : undefined);

  // post-sign envelope mutations (break the outer frame)
  if (c === "evm-magic") {
    update = Uint8Array.from(update);
    update[0] = 0x00; // wrong EVM envelope magic -> ERR_INVALID_EVM_MAGIC (2102)
  } else if (c === "envelope-overlay") {
    update = Uint8Array.from([...update, 0xff]); // byte past the signed payload -> ERR_OVERLAY_PRESENT (2103)
  } else if (c === "bad-signature") {
    update = Uint8Array.from(update);
    update.fill(0x00, 4, 69); // zero r||s||recid: unrecoverable -> ERR_INVALID_SIGNATURE (2104)
  } else if (c === "truncate-envelope") {
    update = update.slice(0, 50); // shorter than the 71-byte envelope header -> ERR_INPUT_TOO_SHORT (2101)
  }
  return update;
}

// PROP name -> decoder output field + signedness. Props not listed here (e.g.
// EmaPrice) are advanced-over by the parser and never appear in the output.
const PROP_OUT: Record<string, { field: string; kind: "int" | "uint" }> = {
  Price: { field: "price", kind: "int" },
  Exponent: { field: "exponent", kind: "int" },
  Confidence: { field: "confidence", kind: "uint" },
  PublisherCount: { field: "publisher-count", kind: "uint" },
  BestBidPrice: { field: "best-bid", kind: "int" },
  BestAskPrice: { field: "best-ask", kind: "int" },
};

// Build the expected decoded feed, or null if the decoder would drop it (a required
// field -- price/exponent/publisher-count -- absent). A 0 in an optional field, and a 0
// price/publisher-count, is Lazer's "missing" sentinel and decodes to none; exponent is
// always literal (a 0 exponent is a real value).
function expectedFeedFromSpec(f: any) {
  const present = new Map<string, bigint>();
  for (const [name, v] of f.props) {
    const o = PROP_OUT[name as string];
    if (!o) continue;
    if (name !== "Exponent" && BigInt(v) === 0n) continue; // sentinel -> none
    present.set(o.field, BigInt(v));
  }
  // A feed missing any required field is dropped by the decoder.
  if (!present.has("price") || !present.has("exponent") || !present.has("publisher-count")) return null;
  const optI = (field: string) => (present.has(field) ? Cl.some(Cl.int(present.get(field)!)) : Cl.none());
  return Cl.tuple({
    "feed-id": Cl.uint(f.id),
    price: Cl.int(present.get("price")!),
    exponent: Cl.int(present.get("exponent")!),
    "publisher-count": Cl.uint(present.get("publisher-count")!),
    confidence: present.has("confidence") ? Cl.some(Cl.uint(present.get("confidence")!)) : Cl.none(),
    "best-bid": optI("best-bid"),
    "best-ask": optI("best-ask"),
    "ema-price": Cl.none(),
    "ema-confidence": Cl.none(),
    "feed-update-timestamp": Cl.none(),
  });
}

const expectedDecodeFromSpec = (spec: any) =>
  Cl.tuple({
    timestamp: Cl.uint(BigInt(spec.timestampUs)),
    channel: Cl.uint(spec.channel),
    "price-feeds": Cl.list(spec.feeds.map(expectedFeedFromSpec).filter((x: any) => x !== null)),
  });

describe("fixtures: captured real Lazer updates", () => {
  it("at least one captured fixture is present", () => {
    expect(captured.length).toBeGreaterThan(0);
  });

  it.each(captured)("decode-and-verify matches the SDK parse: $name", ({ data }) => {
    trustAll();
    expect(decode(hexToBytes(data.evmHex))).toBeOk(capturedDecode(data));
  });

  it("replays captured updates in publish-time order: latest wins, older/equal skipped", () => {
    if (captured.length < 2) return; // nothing to sequence
    trustAll();
    const seq = captured
      .map((c) => c.data)
      .sort((a, b) => (BigInt(a.timestampUs) < BigInt(b.timestampUs) ? -1 : 1));

    // Model the per-feed monotonic guard to predict each submit's write count and
    // the final winner per feed -- works for any set (mixed feeds, gaps, dups).
    // The decoder drops a feed missing any required field (price, exponent,
    // publisher-count), so it never reaches storage -- it neither counts as a write
    // nor lands in storage. Mirror that here (the screened fixtures include feeds
    // without confidence / best-bid / best-ask).
    const winner = new Map<number, { f: any; c: any }>();
    for (const c of seq) {
      let writes = 0;
      for (const f of c.parsed.priceFeeds) {
        if (!hasRequired(f)) continue;
        const w = winner.get(f.priceFeedId);
        if (!w || BigInt(c.timestampUs) > BigInt(w.c.timestampUs)) {
          winner.set(f.priceFeedId, { f, c });
          writes++;
        }
      }
      expect(submit(hexToBytes(c.evmHex))).toBeOk(Cl.uint(writes));
    }

    for (const [id, w] of winner) expect(getPrice(id)).toBeOk(capturedStored(w.f, w.c));

    // Re-submitting the earliest update is fully skipped (every feed is already
    // stored at a >= publish-time), leaving the count at zero.
    expect(submit(hexToBytes(seq[0].evmHex))).toBeOk(Cl.uint(0));
  });
});

describe("fixtures: generated/pass (must decode to its spec)", () => {
  if (genPass.length) {
    it.each(genPass)("$name", ({ data }) => {
      trustAll();
      expect(decode(buildUpdateFromSpec(data))).toBeOk(expectedDecodeFromSpec(data));
    });
  } else {
    it("no generated/pass fixtures yet", () => {});
  }
});

describe("fixtures: generated/fail (must be rejected with expectErr)", () => {
  if (genFail.length) {
    it.each(genFail)("$name", ({ data }) => {
      trustAll();
      expect(decode(buildUpdateFromSpec(data))).toBeErr(Cl.uint(data.expectErr));
    });
  } else {
    it("no generated/fail fixtures yet", () => {});
  }
});
