import { describe, expect, it } from "vitest";
import { Cl, type ClarityValue } from "@stacks/transactions";
import {
  buildEvmUpdate,
  buildLazerPayload,
  OTHER_PRIVKEY,
  PROP,
  TEST_PUBKEY,
  type FeedSpec,
} from "./helpers";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!; // holds both roles + is the default fee recipient
const wallet1 = accounts.get("wallet_1")!; // a relayer/consumer (holds no roles)

const ORACLE = "pyth-lazer-oracle";
const GOV = "pyth-lazer-oracle";
const DECODER_NAME = "pyth-lazer-decoder-v1";

const FAR_FUTURE = 100_000_000_000n;
const TS = 1_700_000_000_000_000n; // microseconds
const REAL_TIME = 1;
// Staleness window wide enough that TS is always "fresh" — simnet's wall clock isn't fixed,
// so tests that aren't about staleness widen the window to take it out of play.
const FRESH_WINDOW = 100_000_000_000_000n;

// Error codes: oracle u1xxx, decoder u21xx, governance u4xxx
const ERR_INVALID_DECODER = 1001;
const ERR_STALE_PRICE = 1002;
const ERR_UNTRUSTED_SIGNER = 2105;
const ERR_PAUSED = 4004;

const decoderRef = Cl.contractPrincipal(deployer, DECODER_NAME);

// Post-deploy bootstrap: trust the test signer and widen the staleness window.
function bootstrap() {
  simnet.callPublicFn(
    GOV,
    "set-trusted-signers",
    [Cl.list([Cl.tuple({ pubkey: Cl.buffer(TEST_PUBKEY), "expires-at": Cl.uint(FAR_FUTURE) })])],
    deployer,
  );
  simnet.callPublicFn(GOV, "set-stale-price-threshold", [Cl.uint(FRESH_WINDOW)], deployer);
}

const makeUpdate = (feeds: FeedSpec[], privKey?: Uint8Array, timestamp = TS) =>
  buildEvmUpdate(buildLazerPayload({ timestamp, channel: REAL_TIME, feeds }), privKey);

// A complete feed: the required fields (price, exponent, publisher-count) plus confidence.
// The decoder DROPS any feed missing a required field, so valid feeds carry a publisher-count.
const feed = (id: number, price: bigint, exponent: bigint, confidence: bigint, pub: bigint): FeedSpec => ({
  id,
  props: [[PROP.Price, price], [PROP.Exponent, exponent], [PROP.Confidence, confidence], [PROP.PublisherCount, pub]],
});

const verify = (update: Uint8Array, sender = wallet1) =>
  simnet.callPublicFn(ORACLE, "verify-price-feeds", [Cl.buffer(update), decoderRef], sender);

// Expected decoded feed: required fields + confidence present; every other optional `none`
// (the updates these tests build carry only the base properties).
const expectedFeed = (id: number, price: bigint, exponent: bigint, confidence: bigint, pub: bigint) =>
  Cl.tuple({
    "feed-id": Cl.uint(id),
    price: Cl.int(price),
    exponent: Cl.int(exponent),
    "publisher-count": Cl.uint(pub),
    confidence: Cl.some(Cl.uint(confidence)),
    "best-bid": Cl.none(),
    "best-ask": Cl.none(),
    "funding-rate": Cl.none(),
    "funding-timestamp": Cl.none(),
    "funding-rate-interval": Cl.none(),
    "market-session": Cl.none(),
    "ema-price": Cl.none(),
    "ema-confidence": Cl.none(),
    "feed-update-timestamp": Cl.none(),
  });

const expectedDecoded = (feeds: ClarityValue[], timestamp = TS, channel = REAL_TIME) =>
  Cl.tuple({
    timestamp: Cl.uint(timestamp),
    channel: Cl.uint(channel),
    "price-feeds": Cl.list(feeds),
  });

describe("pyth-lazer-oracle-v1: verify-price-feeds", () => {
  it("verifies and returns a single decoded feed", () => {
    bootstrap();
    expect(verify(makeUpdate([feed(1, 4_200_000_000n, -8n, 1_500_000n, 18n)])).result)
      .toBeOk(expectedDecoded([expectedFeed(1, 4_200_000_000n, -8n, 1_500_000n, 18n)]));
  });

  it("returns every feed in a multi-feed update", () => {
    bootstrap();
    expect(verify(makeUpdate([feed(1, 100n, -2n, 5n, 7n), feed(2, -50n, -4n, 9n, 8n)])).result)
      .toBeOk(expectedDecoded([
        expectedFeed(1, 100n, -2n, 5n, 7n),
        expectedFeed(2, -50n, -4n, 9n, 8n),
      ]));
  });

  // NOTE: the blessed-decoder rejection path (a conforming but UNBLESSED decoder) isn't unit-
  // tested here -- it needs a second trait-conforming decoder we intentionally don't keep in-repo.
  // The control is a single `(is-eq (contract-of decoder) (get-decoder))` assert, and governance's
  // trait-typed set-decoder guarantees only a real decoder can be blessed.

  it("propagates a decoder verification failure (untrusted signer)", () => {
    bootstrap();
    expect(verify(makeUpdate([feed(1, 1n, 0n, 1n, 1n)], OTHER_PRIVKEY)).result)
      .toBeErr(Cl.uint(ERR_UNTRUSTED_SIGNER));
  });

  it("drops a feed missing a required field (partial success), returning the rest", () => {
    bootstrap();
    // feed 1 is complete; feed 2 has exponent + confidence + publisher-count but NO price.
    const update = makeUpdate([
      feed(1, 100n, -8n, 5n, 7n),
      { id: 2, props: [[PROP.Exponent, -8n], [PROP.Confidence, 9n], [PROP.PublisherCount, 8n]] },
    ]);
    // the price-less feed 2 is dropped by the decoder; only feed 1 comes back.
    expect(verify(update).result).toBeOk(expectedDecoded([expectedFeed(1, 100n, -8n, 5n, 7n)]));
  });

  it("rejects a stale update (publish-time + threshold < now)", () => {
    bootstrap();
    simnet.callPublicFn(GOV, "set-stale-price-threshold", [Cl.uint(0n)], deployer);
    // publish-time 0 with a zero window: 0 + 0 >= now is false for any positive block time.
    expect(verify(makeUpdate([feed(1, 1n, 0n, 1n, 5n)], undefined, 0n)).result)
      .toBeErr(Cl.uint(ERR_STALE_PRICE));
  });

  it("rejects updates while paused (kill-switch), then resumes after unpause", () => {
    bootstrap();
    simnet.callPublicFn(GOV, "pause", [], deployer); // deployer holds the pause role
    expect(verify(makeUpdate([feed(1, 1n, 0n, 1n, 5n)])).result).toBeErr(Cl.uint(ERR_PAUSED));

    simnet.callPublicFn(GOV, "unpause", [], deployer);
    expect(verify(makeUpdate([feed(1, 1n, 0n, 1n, 5n)])).result)
      .toBeOk(expectedDecoded([expectedFeed(1, 1n, 0n, 1n, 5n)]));
  });

  it("charges the per-update fee from the caller to the fee recipient", () => {
    bootstrap();
    simnet.callPublicFn(GOV, "set-fee", [Cl.uint(1000n)], deployer);

    const res = verify(makeUpdate([feed(1, 1n, 0n, 1n, 5n)]), wallet1);
    expect(res.result).toBeOk(expectedDecoded([expectedFeed(1, 1n, 0n, 1n, 5n)]));

    const transfer = res.events.find((e) => e.event === "stx_transfer_event");
    expect(transfer).toBeDefined();
    expect(transfer!.data.amount).toBe("1000");
    expect(transfer!.data.sender).toBe(wallet1);
    expect(transfer!.data.recipient).toBe(deployer);
  });

  it("charges no fee when the fee is zero (default)", () => {
    bootstrap();
    const res = verify(makeUpdate([feed(1, 1n, 0n, 1n, 5n)]), wallet1);
    expect(res.result).toBeOk(expectedDecoded([expectedFeed(1, 1n, 0n, 1n, 5n)]));
    expect(res.events.find((e) => e.event === "stx_transfer_event")).toBeUndefined();
  });
});
