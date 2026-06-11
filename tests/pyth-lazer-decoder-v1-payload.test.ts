import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import { buildEvmUpdate, buildLazerPayload, PROP, TEST_PUBKEY, type FeedSpec } from "./helpers";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;

const DECODER = "pyth-lazer-decoder-v1";
const GOV = "pyth-lazer-governance";

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

function trust() {
  simnet.callPublicFn(
    GOV,
    "set-trusted-signers",
    [Cl.list([Cl.tuple({ pubkey: Cl.buffer(TEST_PUBKEY), "expires-at": Cl.uint(FAR_FUTURE) })])],
    deployer,
  );
}

function decode(payload: Uint8Array) {
  const update = buildEvmUpdate(payload);
  // decode-and-verify-price-feeds is public (it backs the decoder-trait), so call
  // it as a tx; it is pure, so the result is identical to a read-only eval.
  return simnet.callPublicFn(DECODER, "decode-and-verify-price-feeds", [Cl.buffer(update)], deployer)
    .result;
}

const feedRecord = (id: number, price: bigint | null, expo: bigint | null, conf: bigint | null) =>
  Cl.tuple({
    "feed-id": Cl.uint(id),
    price: price === null ? Cl.none() : Cl.some(Cl.int(price)),
    exponent: expo === null ? Cl.none() : Cl.some(Cl.int(expo)),
    confidence: conf === null ? Cl.none() : Cl.some(Cl.uint(conf)),
  });

const decoded = (channel: number, feeds: ReturnType<typeof feedRecord>[]) =>
  Cl.tuple({ timestamp: Cl.uint(TS), channel: Cl.uint(channel), "price-feeds": Cl.list(feeds) });

describe("pyth-lazer-decoder-v1: decode-and-verify-price-feeds (payload parsing)", () => {
  it("decodes a single feed with price / exponent / confidence", () => {
    trust();
    const payload = buildLazerPayload({
      timestamp: TS,
      channel: REAL_TIME,
      feeds: [{ id: 1, props: [[PROP.Price, 4_200_000_000n], [PROP.Exponent, -8n], [PROP.Confidence, 1_500_000n]] }],
    });
    expect(decode(payload)).toBeOk(decoded(REAL_TIME, [feedRecord(1, 4_200_000_000n, -8n, 1_500_000n)]));
  });

  it("decodes multiple feeds (including a negative price)", () => {
    trust();
    const payload = buildLazerPayload({
      timestamp: TS,
      channel: REAL_TIME,
      feeds: [
        { id: 1, props: [[PROP.Price, 100n], [PROP.Exponent, -2n], [PROP.Confidence, 5n]] },
        { id: 2, props: [[PROP.Price, -50n], [PROP.Exponent, -4n], [PROP.Confidence, 9n]] },
      ],
    });
    expect(decode(payload)).toBeOk(
      decoded(REAL_TIME, [feedRecord(1, 100n, -2n, 5n), feedRecord(2, -50n, -4n, 9n)]),
    );
  });

  it("skips non-persisted properties (best bid/ask) while parsing the rest", () => {
    trust();
    const payload = buildLazerPayload({
      timestamp: TS,
      channel: REAL_TIME,
      feeds: [{
        id: 7,
        props: [
          [PROP.Price, 777n],
          [PROP.BestBidPrice, 776n],
          [PROP.Exponent, -6n],
          [PROP.BestAskPrice, 778n],
          [PROP.Confidence, 3n],
        ],
      }],
    });
    expect(decode(payload)).toBeOk(decoded(REAL_TIME, [feedRecord(7, 777n, -6n, 3n)]));
  });

  it("returns none for properties a feed omits", () => {
    trust();
    const payload = buildLazerPayload({
      timestamp: TS,
      channel: REAL_TIME,
      feeds: [{ id: 3, props: [[PROP.Price, 42n]] }],
    });
    expect(decode(payload)).toBeOk(decoded(REAL_TIME, [feedRecord(3, 42n, null, null)]));
  });

  it("rejects a wrong payload magic", () => {
    trust();
    const payload = buildLazerPayload({ timestamp: TS, channel: REAL_TIME, feeds: [{ id: 1, props: [[PROP.Price, 1n]] }] });
    payload[0] = 0x00;
    expect(decode(payload)).toBeErr(Cl.uint(ERR_INVALID_PAYLOAD_MAGIC));
  });

  it("rejects more feeds than MAX_FEEDS (16)", () => {
    trust();
    const feeds: FeedSpec[] = [];
    for (let i = 0; i < 17; i++) feeds.push({ id: i, props: [[PROP.Price, BigInt(i)]] });
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
