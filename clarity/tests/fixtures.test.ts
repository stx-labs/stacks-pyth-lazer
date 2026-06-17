import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import { hexToBytes } from "@noble/hashes/utils";
import { readdirSync, readFileSync } from "node:fs";
import { buildEvmUpdate, buildLazerPayload, PROP, TEST_PUBKEY, type FeedSpec } from "./helpers";

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
  simnet.callPublicFn(DECODER, "decode-and-verify-price-feeds", [Cl.buffer(update)], deployer).result;
const submit = (update: Uint8Array) =>
  simnet.callPublicFn(ORACLE, "verify-and-update-price-feeds", [Cl.buffer(update), decoderRef], relayer).result;
const getPrice = (feedId: number) =>
  simnet.callReadOnlyFn(STORAGE, "get-price", [Cl.uint(feedId)], deployer).result;

const optInt = (v: bigint | null) => (v === null ? Cl.none() : Cl.some(Cl.int(v)));
const optUint = (v: bigint | null) => (v === null ? Cl.none() : Cl.some(Cl.uint(v)));
const big = (v: string | number | null | undefined) => (v === null || v === undefined ? null : BigInt(v));

// === captured: real evm bytes must decode to Pyth's own parsed values ===

const capturedFeed = (f: any) =>
  Cl.tuple({
    "feed-id": Cl.uint(f.priceFeedId),
    price: optInt(big(f.price)),
    exponent: optInt(big(f.exponent)),
    confidence: optUint(big(f.confidence)),
    "publisher-count": optUint(big(f.publisherCount)),
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
    "price-feeds": Cl.list(c.parsed.priceFeeds.map(capturedFeed)),
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

function buildUpdateFromSpec(spec: any): Uint8Array {
  let payload = buildLazerPayload({
    timestamp: BigInt(spec.timestampUs),
    channel: spec.channel,
    feeds: spec.feeds.map(toFeedSpec),
  });
  if (spec.corrupt === "payload-magic") {
    payload = Uint8Array.from(payload);
    payload[0] = 0x00; // break the FORMAT_MAGIC the parser checks first
  } else if (spec.corrupt === "trailing-overlay") {
    payload = Uint8Array.from([...payload, 0xff, 0xff]); // unconsumed bytes after the last feed
  } else if (spec.corrupt) {
    throw new Error(`unknown corrupt directive: ${spec.corrupt}`);
  }
  return buildEvmUpdate(payload); // signs keccak256(payload) with TEST_PRIVKEY
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

function expectedFeedFromSpec(f: any) {
  const t: Record<string, any> = {
    "feed-id": Cl.uint(f.id),
    price: Cl.none(),
    exponent: Cl.none(),
    confidence: Cl.none(),
    "publisher-count": Cl.none(),
    "best-bid": Cl.none(),
    "best-ask": Cl.none(),
    "ema-price": Cl.none(),
    "ema-confidence": Cl.none(),
    "feed-update-timestamp": Cl.none(),
  };
  for (const [name, v] of f.props) {
    const o = PROP_OUT[name as string];
    if (!o) continue;
    t[o.field] = o.kind === "int" ? Cl.some(Cl.int(BigInt(v))) : Cl.some(Cl.uint(BigInt(v)));
  }
  return Cl.tuple(t);
}

const expectedDecodeFromSpec = (spec: any) =>
  Cl.tuple({
    timestamp: Cl.uint(BigInt(spec.timestampUs)),
    channel: Cl.uint(spec.channel),
    "price-feeds": Cl.list(spec.feeds.map(expectedFeedFromSpec)),
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
    const winner = new Map<number, { f: any; c: any }>();
    for (const c of seq) {
      let writes = 0;
      for (const f of c.parsed.priceFeeds) {
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
