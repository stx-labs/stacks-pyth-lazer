import { describe, expect, it } from "vitest";
import { Cl, type ClarityValue } from "@stacks/transactions";
import { hexToBytes } from "@noble/hashes/utils";
import { readdirSync, readFileSync } from "node:fs";
import { buildEvmUpdate, buildLazerPayload, OTHER_PRIVKEY, PROP, TEST_PUBKEY, type FeedSpec } from "./helpers";

// ---------------------------------------------------------------------------
// Data-driven fixture runner. Every file under tests/fixtures/ is a test case;
// add coverage by dropping in a file, no code change needed.
//
//   fixtures/captured/<timestampUs>.json   REAL Lazer `evm` updates from the API
//       { channel, timestampUs, parsed, evmHex } -- evmHex (signed ground truth)
//       must decode to `parsed` (Pyth's own SDK decode).
//
//   fixtures/generated/pass/<name>.json    synthetic specs that MUST decode
//   fixtures/generated/fail/<name>.json    synthetic specs that MUST be rejected
//       { description, channel, timestampUs, feeds: [{ id, props: [[type, dec-str]] }],
//         corrupt?, expectErr? } -- the runner encodes the payload, signs it with the
//       TEST key, and decodes on-chain. `props` type is a PROP name or a raw number
//       (for unknown-type cases); values are decimal strings (big ints / negatives), or
//       null to encode an existence-flagged property (6/7/8/12) as absent (flag 0).
//       pass: the decode must equal the spec. fail: it must error with `expectErr`.
//
// captured fixtures are signed by Pyth's PRODUCTION key; generated ones by the
// synthetic TEST key. The runner trusts both, so every category verifies.
// ---------------------------------------------------------------------------

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!; // governance admin

const GOV = "pyth-lazer-governance";
const DECODER = "pyth-lazer-decoder-v1";

const FAR_FUTURE = 100_000_000_000n;
const PROD_SIGNER = "03a4380f01136eb2640f90c17e1e319e02bbafbeef2e6e67dc48af53f9827e155b";

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

const optInt = (v: bigint | null) => (v === null ? Cl.none() : Cl.some(Cl.int(v)));
const optUint = (v: bigint | null) => (v === null ? Cl.none() : Cl.some(Cl.uint(v)));
const big = (v: string | number | null | undefined) => (v === null || v === undefined ? null : BigInt(v));

// Extended props the decoder parses. Pyth serializes market-session as a label; the decoder
// stores the numeric enum and always keeps it (0 = regular is a real value, not a sentinel).
// ema-price/ema-confidence mirror the decoder's some-if-nonzero collapse (0 -> none). funding-*
// and feed-update-timestamp are existence-flagged: the SDK omits them when absent (-> none) and
// emits the value when present, which optInt/optUint(big(...)) maps straight through.
const SESSION_TO_INT: Record<string, bigint> = { regular: 0n, closed: 4n };
const sessionOpt = (v: string | number | null | undefined) => {
  if (v === null || v === undefined) return Cl.none();
  const n = typeof v === "number" ? BigInt(v) : SESSION_TO_INT[v];
  if (n === undefined) throw new Error(`unmapped market-session label: ${v}`);
  return Cl.some(Cl.uint(n));
};
const nonzeroIntOpt = (v: string | null | undefined) =>
  v == null || BigInt(v) === 0n ? Cl.none() : Cl.some(Cl.int(BigInt(v)));
const nonzeroUintOpt = (v: string | null | undefined) =>
  v == null || BigInt(v) === 0n ? Cl.none() : Cl.some(Cl.uint(BigInt(v)));

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
    "funding-rate": optInt(big(f.fundingRate)),
    "funding-timestamp": optUint(big(f.fundingTimestamp)),
    "funding-rate-interval": optUint(big(f.fundingRateInterval)),
    "market-session": sessionOpt(f.marketSession),
    "ema-price": nonzeroIntOpt(f.emaPrice),
    "ema-confidence": nonzeroUintOpt(f.emaConfidence),
    "feed-update-timestamp": optUint(big(f.feedUpdateTimestamp)),
  });

const capturedDecode = (c: any) =>
  Cl.tuple({
    timestamp: Cl.uint(BigInt(c.parsed.timestampUs)),
    channel: Cl.uint(c.channel),
    "price-feeds": Cl.list(c.parsed.priceFeeds.filter(hasRequired).map(capturedFeed)),
  });

// === generated: build a payload from the spec, then sign with the TEST key ===

const propType = (t: number | string) => (typeof t === "number" ? t : (PROP as Record<string, number>)[t]);
const toFeedSpec = (f: any): FeedSpec => ({
  id: f.id,
  // a null prop value encodes an existence-flagged property (6/7/8/12) as absent (flag 0)
  props: f.props.map(([t, v]: [number | string, string | null]) => [propType(t), v === null ? null : BigInt(v)]),
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

// PROP name -> decoder output field, kind, and how a spec value maps to the stored option:
//   sentinel  -- a 0 value decodes to none (protocol "missing" marker; applies to price, publisher-count, confidence, best-bid/ask, ema-*)
//   literal   -- kept as-is, 0 included (exponent, market-session)
//   existence -- existence-flagged (6/7/8/12): `null` -> none, any bigint -> some (present 0 kept)
type OutRule = "sentinel" | "literal" | "existence";
const PROP_OUT: Record<string, { field: string; kind: "int" | "uint"; rule: OutRule }> = {
  Price: { field: "price", kind: "int", rule: "sentinel" },
  Exponent: { field: "exponent", kind: "int", rule: "literal" },
  Confidence: { field: "confidence", kind: "uint", rule: "sentinel" },
  PublisherCount: { field: "publisher-count", kind: "uint", rule: "sentinel" },
  BestBidPrice: { field: "best-bid", kind: "int", rule: "sentinel" },
  BestAskPrice: { field: "best-ask", kind: "int", rule: "sentinel" },
  FundingRate: { field: "funding-rate", kind: "int", rule: "existence" },
  FundingTimestamp: { field: "funding-timestamp", kind: "uint", rule: "existence" },
  FundingRateInterval: { field: "funding-rate-interval", kind: "uint", rule: "existence" },
  MarketSession: { field: "market-session", kind: "uint", rule: "literal" },
  EmaPrice: { field: "ema-price", kind: "int", rule: "sentinel" },
  EmaConfidence: { field: "ema-confidence", kind: "uint", rule: "sentinel" },
  FeedUpdateTimestamp: { field: "feed-update-timestamp", kind: "uint", rule: "existence" },
};

// The optional tail (every field but feed-id + the 3 required), so the expected tuple is
// built the same regardless of which props a spec carries.
const OPTIONAL_OUT: Array<{ field: string; kind: "int" | "uint" }> = [
  { field: "confidence", kind: "uint" },
  { field: "best-bid", kind: "int" },
  { field: "best-ask", kind: "int" },
  { field: "funding-rate", kind: "int" },
  { field: "funding-timestamp", kind: "uint" },
  { field: "funding-rate-interval", kind: "uint" },
  { field: "market-session", kind: "uint" },
  { field: "ema-price", kind: "int" },
  { field: "ema-confidence", kind: "uint" },
  { field: "feed-update-timestamp", kind: "uint" },
];

// Build the expected decoded feed, or null if the decoder drops it (a required field --
// price/exponent/publisher-count -- resolves to none). Each prop resolves per its rule above.
function expectedFeedFromSpec(f: any) {
  const resolved = new Map<string, bigint | null>();
  for (const [name, v] of f.props) {
    const o = PROP_OUT[name as string];
    if (!o) continue;
    const val: bigint | null = v === null ? null : BigInt(v);
    resolved.set(o.field, o.rule === "sentinel" && val === 0n ? null : val);
  }
  const present = (field: string) => resolved.get(field) != null;
  if (!present("price") || !present("exponent") || !present("publisher-count")) return null;
  const opt = (field: string, kind: "int" | "uint") => {
    const v = resolved.get(field);
    return v == null ? Cl.none() : Cl.some(kind === "int" ? Cl.int(v) : Cl.uint(v));
  };
  const fields: Record<string, ClarityValue> = {
    "feed-id": Cl.uint(f.id),
    price: Cl.int(resolved.get("price")!),
    exponent: Cl.int(resolved.get("exponent")!),
    "publisher-count": Cl.uint(resolved.get("publisher-count")!),
  };
  for (const { field, kind } of OPTIONAL_OUT) fields[field] = opt(field, kind);
  return Cl.tuple(fields);
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
