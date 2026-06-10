import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const wallet1 = accounts.get("wallet_1")!;

const STORAGE = "pyth-lazer-storage";
const GOV = "pyth-lazer-governance";

// Storage error codes (PLAN: storage uses the u3xxx range).
const ERR_UNAUTHORIZED = 3001;
const ERR_NO_AUTHORIZED_WRITER = 3002;
const ERR_PRICE_FEED_NOT_FOUND = 3003;
const ERR_STALE_PRICE = 3004;

const REAL_TIME = 1; // Channel::RealTime
const TS = 1_700_000_000_000_000n; // a plausible publish-time, microseconds

type EntryOpts = {
  feedId: number;
  price?: bigint;
  exponent?: bigint;
  confidence?: bigint;
  publishTime: bigint;
  channel?: number;
};

// The stored record: core fields the v1 decoder populates + the reserved
// optionals (always `none` for v1, matching what the oracle will pass). This is
// exactly what `get-price` returns and what is stored under the feed-id key.
const stored = (o: EntryOpts) =>
  Cl.tuple({
    price: Cl.int(o.price ?? 0n),
    exponent: Cl.int(o.exponent ?? -8n),
    confidence: Cl.uint(o.confidence ?? 0n),
    "publish-time": Cl.uint(o.publishTime),
    channel: Cl.uint(o.channel ?? REAL_TIME),
    "ema-price": Cl.none(),
    "ema-confidence": Cl.none(),
    "best-bid": Cl.none(),
    "best-ask": Cl.none(),
  });

// A `write` batch element: a {feed-id, record} pair. `record` is the value stored
// verbatim under the key (no field-by-field rebuild on-chain).
const entry = (o: EntryOpts) =>
  Cl.tuple({ "feed-id": Cl.uint(o.feedId), record: stored(o) });

// Authorize a writer (gated by governance's admin = deployer). The test sender
// then calls `write` directly, so `contract-caller` equals this principal.
function authorize(writer: string = deployer) {
  return simnet.callPublicFn(STORAGE, "set-authorized-writer", [Cl.principal(writer)], deployer);
}

function setThreshold(seconds: bigint) {
  return simnet.callPublicFn(GOV, "set-stale-price-threshold", [Cl.uint(seconds)], deployer);
}

function write(entries: ReturnType<typeof entry>[], sender: string = deployer) {
  return simnet.callPublicFn(STORAGE, "write", [Cl.list(entries)], sender);
}

const getPrice = (feedId: number) =>
  simnet.callReadOnlyFn(STORAGE, "get-price", [Cl.uint(feedId)], deployer).result;

describe("pyth-lazer-storage: authorized-writer", () => {
  it("has no authorized writer until the admin sets one", () => {
    const { result } = simnet.callReadOnlyFn(STORAGE, "get-authorized-writer", [], deployer);
    expect(result).toBeNone();
  });

  it("rejects a write before an authorized writer is configured", () => {
    const { result } = write([entry({ feedId: 1, publishTime: TS })]);
    expect(result).toBeErr(Cl.uint(ERR_NO_AUTHORIZED_WRITER));
  });

  it("lets only the governance admin set the authorized writer", () => {
    const nonAdmin = simnet.callPublicFn(
      STORAGE,
      "set-authorized-writer",
      [Cl.principal(wallet1)],
      wallet1,
    );
    expect(nonAdmin.result).toBeErr(Cl.uint(ERR_UNAUTHORIZED));

    expect(authorize(wallet1).result).toBeOk(Cl.bool(true));
    const { result } = simnet.callReadOnlyFn(STORAGE, "get-authorized-writer", [], deployer);
    expect(result).toBeSome(Cl.principal(wallet1));
  });

  it("rejects a write from a caller that is not the authorized writer", () => {
    authorize(deployer);
    const { result } = write([entry({ feedId: 1, publishTime: TS })], wallet1);
    expect(result).toBeErr(Cl.uint(ERR_UNAUTHORIZED));
  });
});

describe("pyth-lazer-storage: write + read", () => {
  it("writes a record and reads it back, emitting one event", () => {
    authorize(deployer);
    const e = { feedId: 1, price: 4_200_000_000n, exponent: -8n, confidence: 1_500_000n, publishTime: TS };
    const w = write([entry(e)]);
    expect(w.result).toBeOk(Cl.list([entry(e)]));
    expect(w.events).toHaveLength(1);
    expect(w.events[0].event).toBe("print_event");

    expect(getPrice(1)).toBeOk(stored(e));
  });

  it("returns ERR_PRICE_FEED_NOT_FOUND for an unknown feed", () => {
    expect(getPrice(999)).toBeErr(Cl.uint(ERR_PRICE_FEED_NOT_FOUND));
  });
});

describe("pyth-lazer-storage: monotonic publish-time guard", () => {
  it("accepts a strictly newer update and rejects older/equal ones", () => {
    authorize(deployer);

    expect(write([entry({ feedId: 1, publishTime: 200n })]).result).toBeOk(
      Cl.list([entry({ feedId: 1, publishTime: 200n })]),
    );
    expect(getPrice(1)).toBeOk(stored({ feedId: 1, publishTime: 200n }));

    // older -> skipped (empty success list), stored value unchanged
    const older = write([entry({ feedId: 1, publishTime: 100n })]);
    expect(older.result).toBeOk(Cl.list([]));
    expect(older.events).toHaveLength(0); // no write -> no event
    expect(getPrice(1)).toBeOk(stored({ feedId: 1, publishTime: 200n }));

    // equal -> skipped too (strictly-newer guard)
    expect(write([entry({ feedId: 1, publishTime: 200n })]).result).toBeOk(Cl.list([]));
    expect(getPrice(1)).toBeOk(stored({ feedId: 1, publishTime: 200n }));

    // newer -> accepted
    expect(write([entry({ feedId: 1, publishTime: 300n })]).result).toBeOk(
      Cl.list([entry({ feedId: 1, publishTime: 300n })]),
    );
    expect(getPrice(1)).toBeOk(stored({ feedId: 1, publishTime: 300n }));
  });

  it("applies the guard per-entry: a batch writes the fresh feeds and skips stale ones", () => {
    authorize(deployer);
    write([entry({ feedId: 1, publishTime: 100n }), entry({ feedId: 2, publishTime: 100n })]);

    // feed 1 older (skip), feed 2 newer (write)
    const mixed = write([
      entry({ feedId: 1, publishTime: 50n }),
      entry({ feedId: 2, publishTime: 150n }),
    ]);
    expect(mixed.result).toBeOk(Cl.list([entry({ feedId: 2, publishTime: 150n })]));
    expect(mixed.events).toHaveLength(1);

    expect(getPrice(1)).toBeOk(stored({ feedId: 1, publishTime: 100n }));
    expect(getPrice(2)).toBeOk(stored({ feedId: 2, publishTime: 150n }));
  });
});

describe("pyth-lazer-storage: staleness check", () => {
  it("returns the record when within the staleness window", () => {
    authorize(deployer);
    setThreshold(100_000_000_000_000n); // huge window -> always fresh
    const e = { feedId: 1, price: 7n, exponent: -2n, confidence: 1n, publishTime: TS };
    write([entry(e)]);
    expect(
      simnet.callReadOnlyFn(STORAGE, "read-price-with-staleness-check", [Cl.uint(1)], deployer).result,
    ).toBeOk(stored(e));
  });

  it("rejects a stale price (publish-time + threshold < now)", () => {
    authorize(deployer);
    setThreshold(0n); // any positive wall-clock time is now "stale"
    write([entry({ feedId: 1, publishTime: 0n })]);
    expect(
      simnet.callReadOnlyFn(STORAGE, "read-price-with-staleness-check", [Cl.uint(1)], deployer).result,
    ).toBeErr(Cl.uint(ERR_STALE_PRICE));
  });

  it("returns ERR_PRICE_FEED_NOT_FOUND for an unknown feed", () => {
    expect(
      simnet.callReadOnlyFn(STORAGE, "read-price-with-staleness-check", [Cl.uint(999)], deployer).result,
    ).toBeErr(Cl.uint(ERR_PRICE_FEED_NOT_FOUND));
  });
});
