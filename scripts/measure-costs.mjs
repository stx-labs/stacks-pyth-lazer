// Measure execution costs of the oracle hot paths against REAL captured updates,
// and express them as a fraction of a Stacks block budget. Reproducible input for
// docs/cost-review.md. Run from the repo root:
//
//   node scripts/measure-costs.mjs
//
// Uses two real PROD-signed fixtures: a 3-feed crypto update and a 16-feed equity
// update. Two feed counts give a linear model (fixed overhead + per-feed cost).
import { initSimnet } from "@stacks/clarinet-sdk";
import { Cl } from "@stacks/transactions";
import { readFileSync } from "node:fs";
import { PROD_SIGNER, hexToBytes } from "./lib/lazer.mjs";

const FAR_FUTURE = 100_000_000_000n;
const DECODER = "pyth-lazer-decoder-v1";
const ORACLE = "pyth-lazer-oracle";
const GOV = "pyth-lazer-oracle";

const simnet = await initSimnet("Clarinet.toml", false, { trackCosts: true });
const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer");
const relayer = accounts.get("wallet_1");

// Trust Pyth's production signer (all captured fixtures are signed by it).
simnet.callPublicFn(
  GOV,
  "set-trusted-signers",
  [Cl.list([Cl.tuple({ pubkey: Cl.buffer(hexToBytes(PROD_SIGNER)), "expires-at": Cl.uint(FAR_FUTURE) })])],
  deployer,
);
// Verify-only enforces staleness on the oracle path; widen the window so these fixed-
// timestamp fixtures stay fresh under simnet's (non-fixed) wall clock.
simnet.callPublicFn(GOV, "set-stale-price-threshold", [Cl.uint(100_000_000_000_000n)], deployer);
const decoderRef = Cl.contractPrincipal(deployer, DECODER);

const load = (f) => JSON.parse(readFileSync(`tests/fixtures/captured/${f}`, "utf8"));
const f3 = load("1781553346950000.json"); // 3 feeds (BTC/ETH/SOL), channel 1
const f16 = load("1781725663200000.json"); // 16 feeds (equity), channel 3
const nF3 = f3.parsed.priceFeeds.length;
const nF16 = f16.parsed.priceFeeds.length;

const updBuf = (f) => Cl.buffer(hexToBytes(f.evmHex));
// decode-and-verify-price-feeds is read-only (relayers reach it through the oracle),
// but the SDK meters read-only calls too, so we measure it directly for the decode
// linear model. verify-price-feeds is the public end-to-end verify-and-return entry.

const measurements = [];
function measure(label, res) {
  if (!res.costs) throw new Error(`${label}: no costs (result ${JSON.stringify(res.result)})`);
  if (res.result.type !== "ok") throw new Error(`${label}: not ok -> ${JSON.stringify(res.result)}`);
  measurements.push({ label, t: res.costs.total, limit: res.costs.limit });
  return res;
}

// end-to-end oracle verify -- the consumer's tx (verify + parse + fee path; verify-only, no
// writes). The decoder isn't measured standalone: `verify-update` is gated to the oracle, so
// this is the only verification path.
measure(`verify-price-feeds END-TO-END (${nF3} feeds)`, simnet.callPublicFn(ORACLE, "verify-price-feeds", [updBuf(f3), decoderRef], relayer));
measure(`verify-price-feeds END-TO-END (${nF16} feeds)`, simnet.callPublicFn(ORACLE, "verify-price-feeds", [updBuf(f16), decoderRef], relayer));

const limit = measurements[0].limit;
const dims = [
  ["runtime", "runtime"],
  ["readCount", "read_cnt"],
  ["readLength", "read_len"],
  ["writeCount", "write_cnt"],
  ["writeLength", "write_len"],
];

const pad = (s, n) => String(s).padStart(n);
console.log(`\nBlock budget (limit): runtime=${limit.runtime}  readCount=${limit.readCount}  readLength=${limit.readLength}  writeCount=${limit.writeCount}  writeLength=${limit.writeLength}\n`);
console.log(`${"operation".padEnd(38)}${dims.map(([, h]) => pad(h, 12)).join("")}`);
for (const m of measurements) {
  console.log(`${m.label.padEnd(38)}${dims.map(([k]) => pad(m.t[k], 12)).join("")}`);
}

// % of a block for the end-to-end 16-feed submit (the worst-case relayer tx)
const e2e16 = measurements.find((m) => m.label.startsWith("verify-price-feeds END-TO-END (" + nF16)).t;
console.log(`\nEnd-to-end ${nF16}-feed submit as a fraction of one block:`);
for (const [k, h] of dims) console.log(`  ${h.padEnd(10)} ${(100 * e2e16[k] / limit[k]).toFixed(4)}%`);
const perBlock = Math.floor(limit.runtime / e2e16.runtime);
console.log(`  -> runtime is the binding dimension; ~${perBlock} such submits would fill a block's runtime`);

// linear model from the two end-to-end points
const e2e3 = measurements.find((m) => m.label === `verify-price-feeds END-TO-END (${nF3} feeds)`).t;
const perFeed = (e2e16.runtime - e2e3.runtime) / (nF16 - nF3);
const overhead = e2e3.runtime - perFeed * nF3;
console.log(`\nverify-price-feeds runtime linear model: ~${Math.round(overhead)} fixed (signature+header) + ~${Math.round(perFeed)} per feed`);

process.exit(0);
