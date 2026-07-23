import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import { buildEvmUpdate, buildLazerPayload, PROP, TEST_PUBKEY, type FeedSpec } from "./helpers";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;

const DECODER = "pyth-lazer-decoder-v1";
const ORACLE = "pyth-lazer-oracle";
const GOV = "pyth-lazer-oracle";
const decoderRef = Cl.contractPrincipal(deployer, DECODER);

const FAR_FUTURE = 100_000_000_000n;
const TS = 1_700_000_000_000_000n; // microseconds
const REAL_TIME = 1; // Channel::RealTime

// Phase 2 error codes
const ERR_INVALID_PAYLOAD_MAGIC = 2201;
const ERR_TOO_MANY_FEEDS = 2202;
const ERR_INVALID_FEED_DATA = 2203; // truncated / short read
const ERR_PAYLOAD_OVERLAY = 2204;
const ERR_UNKNOWN_PROPERTY = 2205;
const ERR_TOO_MANY_PROPS = 2206;
const ERR_INVALID_MARKET_SESSION = 2207;

function trust() {
  simnet.callPublicFn(
    GOV,
    "set-trusted-signers",
    [Cl.list([Cl.tuple({ pubkey: Cl.buffer(TEST_PUBKEY), "expires-at": Cl.uint(FAR_FUTURE) })])],
    deployer,
  );
  // widen the staleness window so the fixed test timestamp stays fresh through the oracle
  simnet.callPublicFn(ORACLE, "set-stale-price-threshold", [Cl.uint(100_000_000_000_000n)], deployer);
}

// Verify through the oracle (the sole entry; the decoder rejects direct callers).
function decode(payload: Uint8Array) {
  const update = buildEvmUpdate(payload);
  return simnet.callPublicFn(ORACLE, "verify-price-feeds", [Cl.buffer(update), decoderRef, Cl.none()], deployer)
    .result;
}

const optInt = (v: bigint | null) => (v === null ? Cl.none() : Cl.some(Cl.int(v)));
const optUint = (v: bigint | null) => (v === null ? Cl.none() : Cl.some(Cl.uint(v)));

// The decoded per-feed shape. Every property is optional -- an absent one is `none` and no feed
// is dropped. price/bid/ask/confidence/ema-* collapse a 0 to `none` (protocol sentinel);
// exponent/publisher-count/market-session keep 0 literally; existence-flagged fields
// (fr/ft/fri/fut) pass a present value straight through (a present 0 included).
const feedRecord = (
  id: number,
  price: bigint | null,
  expo: bigint | null,
  pub: bigint | null,
  conf: bigint | null = null,
  extra: {
    bid?: bigint | null;
    ask?: bigint | null;
    ms?: bigint | null;
    ema?: bigint | null;
    emaConf?: bigint | null;
    fr?: bigint | null;
    ft?: bigint | null;
    fri?: bigint | null;
    fut?: bigint | null;
  } = {},
) =>
  Cl.tuple({
    "feed-id": Cl.uint(id),
    price: optInt(price),
    exponent: optInt(expo),
    confidence: optUint(conf),
    "publisher-count": optUint(pub),
    "best-bid": optInt(extra.bid ?? null),
    "best-ask": optInt(extra.ask ?? null),
    "funding-rate": optInt(extra.fr ?? null),
    "funding-timestamp": optUint(extra.ft ?? null),
    "funding-rate-interval": optUint(extra.fri ?? null),
    "market-session": optUint(extra.ms ?? null),
    "ema-price": optInt(extra.ema ?? null),
    "ema-confidence": optUint(extra.emaConf ?? null),
    "feed-update-timestamp": optUint(extra.fut ?? null),
  });

const decoded = (channel: number, feeds: ReturnType<typeof feedRecord>[]) =>
  Cl.tuple({ timestamp: Cl.uint(TS), channel: Cl.uint(channel), "price-feeds": Cl.list(feeds) });

// A fully-populated feed (all 13 properties present) for index i. Values are nonzero wherever
// the decoder collapses 0 -> none, so the decoded record mirrors the input. Each such feed
// encodes to the max 108 bytes (4 id + 1 count + 103 property bytes) -- the worst case for sizing.
const fullFeedValues = (i: number) => ({
  price: BigInt(1_000_000 + i),
  bid: BigInt(999_000 + i),
  ask: BigInt(1_001_000 + i),
  pub: BigInt(1 + i), // nonzero uint16
  expo: -8n,
  conf: BigInt(500 + i),
  fr: BigInt(-(i + 1)), // funding rate: negative + present (existence-flagged)
  ft: BigInt(1_700_000_000_000_000 + i),
  fri: BigInt(3_600 + i),
  ms: BigInt(i % 5), // market session 0-4
  ema: BigInt(1_000_000 + i),
  emaConf: BigInt(500 + i),
  fut: BigInt(1_700_000_000_000_000 + i),
});

const fullFeedSpec = (i: number): FeedSpec => {
  const v = fullFeedValues(i);
  return {
    id: 1000 + i,
    props: [
      [PROP.Price, v.price],
      [PROP.BestBidPrice, v.bid],
      [PROP.BestAskPrice, v.ask],
      [PROP.PublisherCount, v.pub],
      [PROP.Exponent, v.expo],
      [PROP.Confidence, v.conf],
      [PROP.FundingRate, v.fr],
      [PROP.FundingTimestamp, v.ft],
      [PROP.FundingRateInterval, v.fri],
      [PROP.MarketSession, v.ms],
      [PROP.EmaPrice, v.ema],
      [PROP.EmaConfidence, v.emaConf],
      [PROP.FeedUpdateTimestamp, v.fut],
    ],
  };
};

const fullFeedRecord = (i: number) => {
  const v = fullFeedValues(i);
  return feedRecord(1000 + i, v.price, v.expo, v.pub, v.conf, {
    bid: v.bid, ask: v.ask, ms: v.ms, ema: v.ema, emaConf: v.emaConf,
    fr: v.fr, ft: v.ft, fri: v.fri, fut: v.fut,
  });
};

describe("pyth-lazer-decoder-v1: decode-and-verify-price-feeds (payload parsing)", () => {
  it("decodes a single feed with price / exponent / confidence / publisher-count", () => {
    trust();
    const payload = buildLazerPayload({
      timestamp: TS,
      channel: REAL_TIME,
      feeds: [{ id: 1, props: [[PROP.Price, 4_200_000_000n], [PROP.Exponent, -8n], [PROP.Confidence, 1_500_000n], [PROP.PublisherCount, 9n]] }],
    });
    expect(decode(payload)).toBeOk(decoded(REAL_TIME, [feedRecord(1, 4_200_000_000n, -8n, 9n, 1_500_000n)]));
  });

  it("decodes multiple feeds (including a negative price)", () => {
    trust();
    const payload = buildLazerPayload({
      timestamp: TS,
      channel: REAL_TIME,
      feeds: [
        { id: 1, props: [[PROP.Price, 100n], [PROP.Exponent, -2n], [PROP.Confidence, 5n], [PROP.PublisherCount, 2n]] },
        { id: 2, props: [[PROP.Price, -50n], [PROP.Exponent, -4n], [PROP.Confidence, 9n], [PROP.PublisherCount, 3n]] },
      ],
    });
    expect(decode(payload)).toBeOk(
      decoded(REAL_TIME, [feedRecord(1, 100n, -2n, 2n, 5n), feedRecord(2, -50n, -4n, 3n, 9n)]),
    );
  });

  it("captures best-bid, best-ask, and publisher-count (out-of-order properties)", () => {
    trust();
    const payload = buildLazerPayload({
      timestamp: TS,
      channel: REAL_TIME,
      feeds: [{
        id: 7,
        props: [
          [PROP.Price, 777n],
          [PROP.BestBidPrice, 776n],
          [PROP.PublisherCount, 12n],
          [PROP.Exponent, -6n],
          [PROP.BestAskPrice, 778n],
          [PROP.Confidence, 3n],
        ],
      }],
    });
    expect(decode(payload)).toBeOk(
      decoded(REAL_TIME, [feedRecord(7, 777n, -6n, 12n, 3n, { bid: 776n, ask: 778n })]),
    );
  });

  it("decodes the fixed-width extended properties (market-session, ema-price, ema-confidence)", () => {
    trust();
    const payload = buildLazerPayload({
      timestamp: TS,
      channel: REAL_TIME,
      feeds: [{
        id: 4,
        props: [
          [PROP.Price, 5n],
          [PROP.MarketSession, 2n],
          [PROP.Exponent, -3n],
          [PROP.EmaPrice, 999n],
          [PROP.Confidence, 2n],
          [PROP.EmaConfidence, 888n],
          [PROP.PublisherCount, 1n],
        ],
      }],
    });
    expect(decode(payload)).toBeOk(
      decoded(REAL_TIME, [feedRecord(4, 5n, -3n, 1n, 2n, { ms: 2n, ema: 999n, emaConf: 888n })]),
    );
  });

  it("keeps market-session 0 (a real value) but collapses a 0 ema-price to none", () => {
    trust();
    const payload = buildLazerPayload({
      timestamp: TS,
      channel: REAL_TIME,
      feeds: [{
        id: 4,
        props: [[PROP.Price, 5n], [PROP.MarketSession, 0n], [PROP.Exponent, -3n], [PROP.EmaPrice, 0n], [PROP.PublisherCount, 1n]],
      }],
    });
    // market-session 0 is a real value (always present); ema-price 0 is the missing sentinel -> none
    expect(decode(payload)).toBeOk(decoded(REAL_TIME, [feedRecord(4, 5n, -3n, 1n, null, { ms: 0n, ema: null })]));
  });

  it("accepts market-session at the upper boundary (4)", () => {
    trust();
    const payload = buildLazerPayload({
      timestamp: TS,
      channel: REAL_TIME,
      feeds: [{ id: 4, props: [[PROP.Price, 5n], [PROP.MarketSession, 4n], [PROP.Exponent, -3n], [PROP.PublisherCount, 1n]] }],
    });
    // 4 is the inclusive upper bound; pairs with the >4 reject test to pin the boundary.
    expect(decode(payload)).toBeOk(decoded(REAL_TIME, [feedRecord(4, 5n, -3n, 1n, null, { ms: 4n })]));
  });

  it("rejects a market-session value outside 0-4", () => {
    trust();
    const payload = buildLazerPayload({
      timestamp: TS,
      channel: REAL_TIME,
      feeds: [{ id: 4, props: [[PROP.Price, 5n], [PROP.MarketSession, 5n], [PROP.Exponent, -3n], [PROP.PublisherCount, 1n]] }],
    });
    expect(decode(payload)).toBeErr(Cl.uint(ERR_INVALID_MARKET_SESSION));
  });

  it("decodes the existence-flagged properties when present (funding-*, feed-update-timestamp)", () => {
    trust();
    const payload = buildLazerPayload({
      timestamp: TS,
      channel: REAL_TIME,
      feeds: [{
        id: 8,
        props: [
          [PROP.Price, 5n],
          [PROP.FundingRate, -125n], // int64: funding rates can be negative
          [PROP.Exponent, -3n],
          [PROP.FundingTimestamp, 1_700_000_000n],
          [PROP.PublisherCount, 1n],
          [PROP.FundingRateInterval, 3_600n],
          [PROP.FeedUpdateTimestamp, 1_699_999_999n],
        ],
      }],
    });
    expect(decode(payload)).toBeOk(
      decoded(REAL_TIME, [
        feedRecord(8, 5n, -3n, 1n, null, { fr: -125n, ft: 1_700_000_000n, fri: 3_600n, fut: 1_699_999_999n }),
      ]),
    );
  });

  it("keeps a present funding-rate / funding-timestamp of 0 as some(0) -- the flag signals presence, not a nonzero value", () => {
    trust();
    const payload = buildLazerPayload({
      timestamp: TS,
      channel: REAL_TIME,
      feeds: [{
        id: 8,
        props: [[PROP.Price, 5n], [PROP.Exponent, -3n], [PROP.PublisherCount, 1n], [PROP.FundingRate, 0n], [PROP.FundingTimestamp, 0n]],
      }],
    });
    // Contrast the "0 ema-price -> none" test above: existence-flagged types never collapse 0.
    expect(decode(payload)).toBeOk(decoded(REAL_TIME, [feedRecord(8, 5n, -3n, 1n, null, { fr: 0n, ft: 0n })]));
  });

  it("decodes existence-flagged properties as none when their flag is 0 (declared but absent)", () => {
    trust();
    const payload = buildLazerPayload({
      timestamp: TS,
      channel: REAL_TIME,
      feeds: [{
        id: 8,
        // null value => existence flag 0 => the property occupies a single byte and yields none
        props: [[PROP.Price, 5n], [PROP.Exponent, -3n], [PROP.PublisherCount, 1n], [PROP.FundingRate, null], [PROP.FeedUpdateTimestamp, null]],
      }],
    });
    expect(decode(payload)).toBeOk(decoded(REAL_TIME, [feedRecord(8, 5n, -3n, 1n)]));
  });

  it("keeps a feed missing a required field, decoding that field as none", () => {
    trust();
    const payload = buildLazerPayload({
      timestamp: TS,
      channel: REAL_TIME,
      feeds: [
        { id: 3, props: [[PROP.Price, 42n]] }, // no exponent / publisher-count -> those decode to none
        { id: 5, props: [[PROP.Price, 7n], [PROP.Exponent, -1n], [PROP.PublisherCount, 4n]] },
      ],
    });
    // neither feed is dropped; feed 3 comes back with exponent/publisher-count none
    expect(decode(payload)).toBeOk(decoded(REAL_TIME, [feedRecord(3, 42n, null, null), feedRecord(5, 7n, -1n, 4n)]));
  });

  it("keeps a feed with zero properties as an all-none feed", () => {
    trust();
    const payload = buildLazerPayload({ timestamp: TS, channel: REAL_TIME, feeds: [{ id: 9, props: [] }] });
    expect(decode(payload)).toBeOk(decoded(REAL_TIME, [feedRecord(9, null, null, null)]));
  });

  it("keeps a feed missing only price (price none, others present)", () => {
    trust();
    const payload = buildLazerPayload({
      timestamp: TS,
      channel: REAL_TIME,
      feeds: [{ id: 9, props: [[PROP.Exponent, -8n], [PROP.PublisherCount, 3n], [PROP.Confidence, 5n]] }],
    });
    expect(decode(payload)).toBeOk(decoded(REAL_TIME, [feedRecord(9, null, -8n, 3n, 5n)]));
  });

  it("keeps a feed missing only exponent (exponent none)", () => {
    trust();
    const payload = buildLazerPayload({
      timestamp: TS,
      channel: REAL_TIME,
      feeds: [{ id: 9, props: [[PROP.Price, 5n], [PROP.PublisherCount, 3n]] }],
    });
    expect(decode(payload)).toBeOk(decoded(REAL_TIME, [feedRecord(9, 5n, null, 3n)]));
  });

  it("keeps a feed missing only publisher-count (publisher-count none)", () => {
    trust();
    const payload = buildLazerPayload({
      timestamp: TS,
      channel: REAL_TIME,
      feeds: [{ id: 9, props: [[PROP.Price, 5n], [PROP.Exponent, -8n]] }],
    });
    expect(decode(payload)).toBeOk(decoded(REAL_TIME, [feedRecord(9, 5n, -8n, null)]));
  });

  it("keeps a publisher-count of 0 as some(0) -- uint16, no 0-sentinel", () => {
    trust();
    const payload = buildLazerPayload({
      timestamp: TS,
      channel: REAL_TIME,
      feeds: [{ id: 9, props: [[PROP.Price, 5n], [PROP.Exponent, -8n], [PROP.PublisherCount, 0n]] }],
    });
    expect(decode(payload)).toBeOk(decoded(REAL_TIME, [feedRecord(9, 5n, -8n, 0n)]));
  });

  it("collapses a 0 price to none but still keeps the feed", () => {
    trust();
    const payload = buildLazerPayload({
      timestamp: TS,
      channel: REAL_TIME,
      feeds: [{ id: 9, props: [[PROP.Price, 0n], [PROP.Exponent, -8n], [PROP.PublisherCount, 3n]] }],
    });
    // price 0 is the Option<Price> sentinel -> none; the feed is returned, not dropped
    expect(decode(payload)).toBeOk(decoded(REAL_TIME, [feedRecord(9, null, -8n, 3n)]));
  });

  it("rejects a wrong payload magic", () => {
    trust();
    const payload = buildLazerPayload({ timestamp: TS, channel: REAL_TIME, feeds: [{ id: 1, props: [[PROP.Price, 1n]] }] });
    payload[0] = 0x00;
    expect(decode(payload)).toBeErr(Cl.uint(ERR_INVALID_PAYLOAD_MAGIC));
  });

  it("decodes the maximum 75 fully-populated feeds (buffer upper bound)", () => {
    trust();
    const feeds = Array.from({ length: 75 }, (_, i) => fullFeedSpec(i));
    const payload = buildLazerPayload({ timestamp: TS, channel: REAL_TIME, feeds });
    // 75 * 108-byte feeds + 14-byte payload header + 71-byte envelope = 8185, just within (buff 8192)
    expect(buildEvmUpdate(payload).length).toBe(8185);
    const expected = feeds.map((_, i) => fullFeedRecord(i));
    expect(decode(payload)).toBeOk(decoded(REAL_TIME, expected));
  });

  it("rejects more feeds than MAX_FEEDS (75)", () => {
    trust();
    const feeds: FeedSpec[] = [];
    for (let i = 0; i < 76; i++) feeds.push({ id: i, props: [[PROP.Price, BigInt(i + 1)]] });
    const payload = buildLazerPayload({ timestamp: TS, channel: REAL_TIME, feeds });
    expect(decode(payload)).toBeErr(Cl.uint(ERR_TOO_MANY_FEEDS));
  });

  it("rejects an unknown property type (distinct error code)", () => {
    trust();
    const payload = buildLazerPayload({ timestamp: TS, channel: REAL_TIME, feeds: [{ id: 1, props: [[13, 1n]] }] });
    expect(decode(payload)).toBeErr(Cl.uint(ERR_UNKNOWN_PROPERTY));
  });

  it("rejects a feed that declares more properties than exist (distinct error code)", () => {
    trust();
    const props: Array<[number, bigint]> = [];
    for (let i = 0; i < 14; i++) props.push([PROP.Price, 1n]); // 14 > 13 property slots
    const payload = buildLazerPayload({ timestamp: TS, channel: REAL_TIME, feeds: [{ id: 1, props }] });
    expect(decode(payload)).toBeErr(Cl.uint(ERR_TOO_MANY_PROPS));
  });

  it("rejects a truncated feed (short read mid-property)", () => {
    trust();
    // Build a valid feed, then drop the last few bytes of the payload so the
    // declared property value runs past the end.
    const full = buildLazerPayload({ timestamp: TS, channel: REAL_TIME, feeds: [{ id: 1, props: [[PROP.Price, 1n]] }] });
    const truncated = full.slice(0, full.length - 3);
    expect(decode(truncated)).toBeErr(Cl.uint(ERR_INVALID_FEED_DATA));
  });

  it("rejects trailing overlay bytes in the payload", () => {
    trust();
    const base = buildLazerPayload({ timestamp: TS, channel: REAL_TIME, feeds: [{ id: 1, props: [[PROP.Price, 1n]] }] });
    const payload = Uint8Array.from([...base, 0xff, 0xff]);
    expect(decode(payload)).toBeErr(Cl.uint(ERR_PAYLOAD_OVERLAY));
  });
});
