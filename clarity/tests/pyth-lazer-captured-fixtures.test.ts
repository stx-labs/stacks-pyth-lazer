import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import { hexToBytes } from "@noble/hashes/utils";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// The full set of REAL Pyth Lazer `evm` updates captured from the live API
// (scripts/gen-lazer-fixture.mjs -> tests/fixtures/lazer/captured-updates.json).
//
// pyth-lazer-golden-fixture.test.ts uses just ONE of these as a byte-order anchor;
// this file exercises ALL of them:
//   1. every capture decodes to the SDK's own parsed values (real-byte regression);
//   2. replaying them as the real ascending sequence they were captured in proves
//      the storage monotonic guard (latest wins; older/equal publish-time skipped).
//
// All captures are 3 feeds (BTC=1, ETH=2, SOL=6) with the full property set
// (price/exponent/confidence/best-bid/best-ask/publisher-count), 50 ms apart, signed
// by Pyth's PRODUCTION signer. Values are public market data.
// ---------------------------------------------------------------------------

const captured = JSON.parse(
  readFileSync(new URL("./fixtures/lazer/captured-updates.json", import.meta.url), "utf8"),
);

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!; // governance admin + storage's default writer's admin
const relayer = accounts.get("wallet_1")!; // submission is permissionless -- a non-admin relayer

const ORACLE = "pyth-lazer-oracle-v1";
const GOV = "pyth-lazer-governance";
const STORAGE = "pyth-lazer-storage";
const DECODER = "pyth-lazer-decoder-v1";

const FAR_FUTURE = 100_000_000_000n;
const CHANNEL = 1; // metadata channel "real_time" == Channel::RealTime == u1
// Pyth's production signer (compressed pubkey); recovered/verified in the golden test.
const PROD_SIGNER = "03a4380f01136eb2640f90c17e1e319e02bbafbeef2e6e67dc48af53f9827e155b";

const decoderRef = Cl.contractPrincipal(deployer, DECODER);

function trust() {
  simnet.callPublicFn(
    GOV,
    "set-trusted-signers",
    [Cl.list([Cl.tuple({ pubkey: Cl.buffer(hexToBytes(PROD_SIGNER)), "expires-at": Cl.uint(FAR_FUTURE) })])],
    deployer,
  );
}

const decode = (evmHex: string) =>
  simnet.callPublicFn(DECODER, "decode-and-verify-price-feeds", [Cl.buffer(hexToBytes(evmHex))], deployer).result;

const submit = (evmHex: string) =>
  simnet.callPublicFn(ORACLE, "verify-and-update-price-feeds", [Cl.buffer(hexToBytes(evmHex)), decoderRef], relayer).result;

const getPrice = (feedId: number) =>
  simnet.callReadOnlyFn(STORAGE, "get-price", [Cl.uint(feedId)], deployer).result;

// One SDK-parsed feed -> the decoder's per-feed output tuple. ema-* and
// feed-update-timestamp are not in the v1 subscription, so they decode to `none`.
const decodedFeed = (f: any) =>
  Cl.tuple({
    "feed-id": Cl.uint(f.priceFeedId),
    price: Cl.some(Cl.int(BigInt(f.price))),
    exponent: Cl.some(Cl.int(BigInt(f.exponent))),
    confidence: Cl.some(Cl.uint(BigInt(f.confidence))),
    "publisher-count": Cl.some(Cl.uint(BigInt(f.publisherCount))),
    "best-bid": Cl.some(Cl.int(BigInt(f.bestBidPrice))),
    "best-ask": Cl.some(Cl.int(BigInt(f.bestAskPrice))),
    "ema-price": Cl.none(),
    "ema-confidence": Cl.none(),
    "feed-update-timestamp": Cl.none(),
  });

const expectedDecode = (u: any) =>
  Cl.tuple({
    timestamp: Cl.uint(BigInt(u.parsed.timestampUs)),
    channel: Cl.uint(CHANNEL),
    "price-feeds": Cl.list(u.parsed.priceFeeds.map(decodedFeed)),
  });

// One SDK-parsed feed -> the stored record (decoder output + oracle-supplied
// publish-time/channel). Unlike the synthetic oracle tests, these carry best-bid /
// best-ask, so this confirms those survive end-to-end into storage.
const storedFeed = (f: any, timestampUs: string) =>
  Cl.tuple({
    price: Cl.int(BigInt(f.price)),
    exponent: Cl.int(BigInt(f.exponent)),
    "publisher-count": Cl.uint(BigInt(f.publisherCount)),
    confidence: Cl.some(Cl.uint(BigInt(f.confidence))),
    "best-bid": Cl.some(Cl.int(BigInt(f.bestBidPrice))),
    "best-ask": Cl.some(Cl.int(BigInt(f.bestAskPrice))),
    "ema-price": Cl.none(),
    "ema-confidence": Cl.none(),
    "feed-update-timestamp": Cl.none(),
    "publish-time": Cl.uint(BigInt(timestampUs)),
    channel: Cl.uint(CHANNEL),
  });

describe("pyth-lazer: captured real fixtures (all 8 updates)", () => {
  it("captured a known set: 8 updates, 3 feeds each, real_time channel", () => {
    // Guards the assumptions the rest of the file (and CHANNEL) rely on.
    expect(captured.updates).toHaveLength(8);
    expect(captured.channel).toBe("real_time");
    for (const u of captured.updates) expect(u.parsed.priceFeeds).toHaveLength(3);
  });

  it.each(captured.updates)(
    "decode-and-verify matches the SDK decode for captured update seq=$seq",
    (u: any) => {
      trust();
      expect(decode(u.evmHex)).toBeOk(expectedDecode(u));
    },
  );

  it("replays the real ascending sequence: latest wins, older/equal is skipped", () => {
    trust();
    const updates = captured.updates;

    // Submit all 8 in capture order. Each is 50 ms newer than the last, so all
    // three feeds clear the strictly-newer guard every time -> 3 writes each.
    for (const u of updates) expect(submit(u.evmHex)).toBeOk(Cl.uint(3));

    // Storage now holds the LAST update's values for every feed.
    const last = updates[updates.length - 1];
    for (const f of last.parsed.priceFeeds) {
      expect(getPrice(f.priceFeedId)).toBeOk(storedFeed(f, last.parsed.timestampUs));
    }

    // Re-submitting the OLDEST update is fully skipped by the monotonic guard
    // (0 writes), and storage is left untouched.
    expect(submit(updates[0].evmHex)).toBeOk(Cl.uint(0));
    for (const f of last.parsed.priceFeeds) {
      expect(getPrice(f.priceFeedId)).toBeOk(storedFeed(f, last.parsed.timestampUs));
    }

    // Re-submitting the latest update again (EQUAL publish-time) is also skipped.
    expect(submit(last.evmHex)).toBeOk(Cl.uint(0));
  });
});
