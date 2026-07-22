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

// The decoded per-feed shape. price/exponent/publisher-count are required (feeds missing them
// are dropped); every other field is `some` when present, else `none`. For the existence-flagged
// fields (fr/ft/fri/fut) a present value passes straight through (a present 0 included).
const feedRecord = (
  id: number,
  price: bigint,
  expo: bigint,
  pub: bigint,
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
    price: Cl.int(price),
    exponent: Cl.int(expo),
    confidence: optUint(conf),
    "publisher-count": Cl.uint(pub),
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

  it("drops a feed missing a required field, keeping the complete ones", () => {
    trust();
    const payload = buildLazerPayload({
      timestamp: TS,
      channel: REAL_TIME,
      feeds: [
        { id: 3, props: [[PROP.Price, 42n]] }, // no exponent / publisher-count -> dropped
        { id: 5, props: [[PROP.Price, 7n], [PROP.Exponent, -1n], [PROP.PublisherCount, 4n]] },
      ],
    });
    expect(decode(payload)).toBeOk(decoded(REAL_TIME, [feedRecord(5, 7n, -1n, 4n)]));
  });

  it("rejects a wrong payload magic", () => {
    trust();
    const payload = buildLazerPayload({ timestamp: TS, channel: REAL_TIME, feeds: [{ id: 1, props: [[PROP.Price, 1n]] }] });
    payload[0] = 0x00;
    expect(decode(payload)).toBeErr(Cl.uint(ERR_INVALID_PAYLOAD_MAGIC));
  });

  it("rejects more feeds than MAX_FEEDS (32)", () => {
    trust();
    const feeds: FeedSpec[] = [];
    for (let i = 0; i < 33; i++) feeds.push({ id: i, props: [[PROP.Price, BigInt(i + 1)]] });
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
