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
const deployer = accounts.get("deployer")!; // also the default admin + fee recipient
const wallet1 = accounts.get("wallet_1")!; // a relayer (not the admin)

const ORACLE = "pyth-lazer-oracle-v1";
const GOV = "pyth-lazer-governance";
const STORAGE = "pyth-lazer-storage";
const DECODER_NAME = "pyth-lazer-decoder-v1";

const FAR_FUTURE = 100_000_000_000n;
const TS = 1_700_000_000_000_000n; // microseconds
const REAL_TIME = 1;

// Oracle error codes
const ERR_INVALID_DECODER = 1001;
const ERR_MISSING_PRICE = 1003;
// Propagated from the decoder / storage
const ERR_UNTRUSTED_SIGNER = 2105;
const ERR_UNAUTHORIZED = 3001; // storage's write gate

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

const submit = (update: Uint8Array, sender = wallet1) =>
  simnet.callPublicFn(ORACLE, "verify-and-update-price-feeds", [Cl.buffer(update), decoderRef], sender);

const getPrice = (feedId: number) =>
  simnet.callReadOnlyFn(STORAGE, "get-price", [Cl.uint(feedId)], deployer).result;

// Expected stored record for a feed with the given core values (v1 optionals = none).
const storedRecord = (price: bigint, exponent: bigint, confidence: bigint) =>
  Cl.tuple({
    price: Cl.int(price),
    exponent: Cl.int(exponent),
    confidence: Cl.uint(confidence),
    "publish-time": Cl.uint(TS),
    channel: Cl.uint(REAL_TIME),
    "ema-price": Cl.none(),
    "ema-confidence": Cl.none(),
    "best-bid": Cl.none(),
    "best-ask": Cl.none(),
  });

describe("pyth-lazer-oracle-v1: verify-and-update-price-feeds", () => {
  it("verifies, decodes, and stores a single feed", () => {
    bootstrap();
    const update = makeUpdate([
      { id: 1, props: [[PROP.Price, 4_200_000_000n], [PROP.Exponent, -8n], [PROP.Confidence, 1_500_000n]] },
    ]);
    expect(submit(update).result).toBeOk(Cl.uint(1)); // 1 feed written
    expect(getPrice(1)).toBeOk(storedRecord(4_200_000_000n, -8n, 1_500_000n));
  });

  it("stores every feed in a multi-feed update", () => {
    bootstrap();
    const update = makeUpdate([
      { id: 1, props: [[PROP.Price, 100n], [PROP.Exponent, -2n], [PROP.Confidence, 5n]] },
      { id: 2, props: [[PROP.Price, -50n], [PROP.Exponent, -4n], [PROP.Confidence, 9n]] },
    ]);
    expect(submit(update).result).toBeOk(Cl.uint(2));
    expect(getPrice(1)).toBeOk(storedRecord(100n, -2n, 5n));
    expect(getPrice(2)).toBeOk(storedRecord(-50n, -4n, 9n));
  });

  it("rejects a decoder that is not the blessed one", () => {
    // re-point the blessed decoder away from the one we pass
    simnet.callPublicFn(GOV, "set-decoder", [Cl.contractPrincipal(deployer, STORAGE)], deployer);
    const update = makeUpdate([{ id: 1, props: [[PROP.Price, 1n], [PROP.Exponent, 0n], [PROP.Confidence, 1n]] }]);
    expect(submit(update).result).toBeErr(Cl.uint(ERR_INVALID_DECODER));
  });

  it("propagates a decoder verification failure (untrusted signer)", () => {
    bootstrap();
    const update = makeUpdate(
      [{ id: 1, props: [[PROP.Price, 1n], [PROP.Exponent, 0n], [PROP.Confidence, 1n]] }],
      OTHER_PRIVKEY,
    );
    expect(submit(update).result).toBeErr(Cl.uint(ERR_UNTRUSTED_SIGNER));
  });

  it("is rejected by storage when the writer is re-pointed away from the oracle", () => {
    bootstrap();
    // admin points storage's writer at someone else; the oracle can no longer write
    simnet.callPublicFn(STORAGE, "set-authorized-writer", [Cl.principal(wallet1)], deployer);
    const update = makeUpdate([{ id: 1, props: [[PROP.Price, 1n], [PROP.Exponent, 0n], [PROP.Confidence, 1n]] }]);
    expect(submit(update).result).toBeErr(Cl.uint(ERR_UNAUTHORIZED));
  });

  it("enforces the required core fields (rejects a feed with no price)", () => {
    bootstrap();
    // a feed carrying exponent + confidence but no price
    const update = makeUpdate([{ id: 1, props: [[PROP.Exponent, -8n], [PROP.Confidence, 1n]] }]);
    expect(submit(update).result).toBeErr(Cl.uint(ERR_MISSING_PRICE));
  });

  it("charges the per-update fee from the relayer to the admin", () => {
    bootstrap();
    simnet.callPublicFn(GOV, "set-fee", [Cl.uint(1000n)], deployer);
    const update = makeUpdate([{ id: 1, props: [[PROP.Price, 1n], [PROP.Exponent, 0n], [PROP.Confidence, 1n]] }]);

    const res = submit(update, wallet1);
    expect(res.result).toBeOk(Cl.uint(1));

    const transfer = res.events.find((e) => e.event === "stx_transfer_event");
    expect(transfer).toBeDefined();
    expect(transfer!.data.amount).toBe("1000");
    expect(transfer!.data.sender).toBe(wallet1);
    expect(transfer!.data.recipient).toBe(deployer);
  });

  it("charges no fee when the fee is zero (default)", () => {
    bootstrap();
    const update = makeUpdate([{ id: 1, props: [[PROP.Price, 1n], [PROP.Exponent, 0n], [PROP.Confidence, 1n]] }]);
    const res = submit(update, wallet1);
    expect(res.result).toBeOk(Cl.uint(1));
    expect(res.events.find((e) => e.event === "stx_transfer_event")).toBeUndefined();
  });
});
