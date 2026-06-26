import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
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
const wallet1 = accounts.get("wallet_1")!; // a relayer (holds no roles)

const ORACLE = "pyth-lazer-oracle-v1";
const GOV = "pyth-lazer-governance";
const STORAGE = "pyth-lazer-storage";
const DECODER_NAME = "pyth-lazer-decoder-v1";

const FAR_FUTURE = 100_000_000_000n;
const TS = 1_700_000_000_000_000n; // microseconds
const REAL_TIME = 1;

// Error codes propagated from the decoder / storage / governance
const ERR_UNTRUSTED_SIGNER = 2105;
const ERR_UNAUTHORIZED = 3001; // storage's write gate
const ERR_PRICE_FEED_NOT_FOUND = 3003; // storage: no record for the feed
const ERR_PAUSED = 4004; // governance: protocol paused

const decoderRef = Cl.contractPrincipal(deployer, DECODER_NAME);

// The only required post-deploy step: register a trusted signer. The blessed
// decoder and storage's authorized-writer both default to the v1 contracts.
function bootstrap() {
  simnet.callPublicFn(
    GOV,
    "set-trusted-signers",
    [Cl.list([Cl.tuple({ pubkey: Cl.buffer(TEST_PUBKEY), "expires-at": Cl.uint(FAR_FUTURE) })])],
    deployer,
  );
}

function makeUpdate(feeds: FeedSpec[], privKey?: Uint8Array) {
  return buildEvmUpdate(buildLazerPayload({ timestamp: TS, channel: REAL_TIME, feeds }), privKey);
}

// A complete v1 feed: the oracle's required fields (price, exponent,
// publisher-count) plus confidence. The oracle SKIPS any feed missing a required
// field, so valid feeds must carry a publisher-count.
const feed = (id: number, price: bigint, exponent: bigint, confidence: bigint, pub: bigint): FeedSpec => ({
  id,
  props: [[PROP.Price, price], [PROP.Exponent, exponent], [PROP.Confidence, confidence], [PROP.PublisherCount, pub]],
});

const submit = (update: Uint8Array, sender = wallet1) =>
  simnet.callPublicFn(ORACLE, "verify-and-update-price-feeds", [Cl.buffer(update), decoderRef], sender);

const getPrice = (feedId: number) =>
  simnet.callReadOnlyFn(STORAGE, "get-price", [Cl.uint(feedId)], deployer).result;

// Expected stored record (finalized schema). The oracle requires
// price/exponent/publisher-count and passes confidence through; best-bid/best-ask,
// ema-*, and feed-update-timestamp are `none` for the updates these tests build.
const storedRecord = (price: bigint, exponent: bigint, confidence: bigint, publisherCount: bigint) =>
  Cl.tuple({
    price: Cl.int(price),
    exponent: Cl.int(exponent),
    "publisher-count": Cl.uint(publisherCount),
    confidence: Cl.some(Cl.uint(confidence)),
    "best-bid": Cl.none(),
    "best-ask": Cl.none(),
    "ema-price": Cl.none(),
    "ema-confidence": Cl.none(),
    "feed-update-timestamp": Cl.none(),
    "publish-time": Cl.uint(TS),
    channel: Cl.uint(REAL_TIME),
  });

describe("pyth-lazer-oracle-v1: verify-and-update-price-feeds", () => {
  it("verifies, decodes, and stores a single feed", () => {
    bootstrap();
    expect(submit(makeUpdate([feed(1, 4_200_000_000n, -8n, 1_500_000n, 18n)])).result).toBeOk(Cl.uint(1));
    expect(getPrice(1)).toBeOk(storedRecord(4_200_000_000n, -8n, 1_500_000n, 18n));
  });

  it("stores every feed in a multi-feed update", () => {
    bootstrap();
    expect(submit(makeUpdate([feed(1, 100n, -2n, 5n, 7n), feed(2, -50n, -4n, 9n, 8n)])).result).toBeOk(Cl.uint(2));
    expect(getPrice(1)).toBeOk(storedRecord(100n, -2n, 5n, 7n));
    expect(getPrice(2)).toBeOk(storedRecord(-50n, -4n, 9n, 8n));
  });

  // NOTE: the oracle's blessed-decoder rejection path (passing a conforming but
  // UNBLESSED decoder) is not unit-tested here -- triggering it needs a second
  // trait-conforming decoder contract, which we intentionally don't keep in-repo.
  // The control is a single `(is-eq (contract-of decoder) (get-decoder))` assert that
  // runs before the decoder executes, and governance's trait-typed `set-decoder`
  // guarantees only a real decoder can be blessed in the first place.

  it("propagates a decoder verification failure (untrusted signer)", () => {
    bootstrap();
    expect(submit(makeUpdate([feed(1, 1n, 0n, 1n, 1n)], OTHER_PRIVKEY)).result).toBeErr(Cl.uint(ERR_UNTRUSTED_SIGNER));
  });

  it("is rejected by storage when the writer is re-pointed away from the oracle", () => {
    bootstrap();
    // admin points storage's writer at someone else; the oracle can no longer write
    simnet.callPublicFn(STORAGE, "set-authorized-writer", [Cl.principal(wallet1)], deployer);
    expect(submit(makeUpdate([feed(1, 1n, 0n, 1n, 1n)])).result).toBeErr(Cl.uint(ERR_UNAUTHORIZED));
  });

  it("skips a feed with no price (partial success), storing the rest", () => {
    bootstrap();
    // feed 1 is complete; feed 2 has exponent + confidence + publisher-count but NO price.
    const update = makeUpdate([
      feed(1, 100n, -8n, 5n, 7n),
      { id: 2, props: [[PROP.Exponent, -8n], [PROP.Confidence, 9n], [PROP.PublisherCount, 8n]] },
    ]);
    // only feed 1 is stored; the price-less feed 2 is dropped, not surfaced as an error.
    expect(submit(update).result).toBeOk(Cl.uint(1));
    expect(getPrice(1)).toBeOk(storedRecord(100n, -8n, 5n, 7n));
    expect(getPrice(2)).toBeErr(Cl.uint(ERR_PRICE_FEED_NOT_FOUND));
  });

  it("rejects updates while the protocol is paused, then resumes after unpause", () => {
    bootstrap();
    simnet.callPublicFn(GOV, "pause", [], deployer); // deployer holds the pause role
    expect(submit(makeUpdate([feed(1, 1n, 0n, 1n, 5n)])).result).toBeErr(Cl.uint(ERR_PAUSED));

    simnet.callPublicFn(GOV, "unpause", [], deployer);
    expect(submit(makeUpdate([feed(1, 1n, 0n, 1n, 5n)])).result).toBeOk(Cl.uint(1));
  });

  it("charges the per-update fee from the relayer to the fee recipient", () => {
    bootstrap();
    simnet.callPublicFn(GOV, "set-fee", [Cl.uint(1000n)], deployer);

    const res = submit(makeUpdate([feed(1, 1n, 0n, 1n, 5n)]), wallet1);
    expect(res.result).toBeOk(Cl.uint(1));

    const transfer = res.events.find((e) => e.event === "stx_transfer_event");
    expect(transfer).toBeDefined();
    expect(transfer!.data.amount).toBe("1000");
    expect(transfer!.data.sender).toBe(wallet1);
    expect(transfer!.data.recipient).toBe(deployer);
  });

  it("charges no fee when the fee is zero (default)", () => {
    bootstrap();
    const res = submit(makeUpdate([feed(1, 1n, 0n, 1n, 5n)]), wallet1);
    expect(res.result).toBeOk(Cl.uint(1));
    expect(res.events.find((e) => e.event === "stx_transfer_event")).toBeUndefined();
  });
});
