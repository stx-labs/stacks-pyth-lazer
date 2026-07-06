#!/usr/bin/env node
// One-shot: generate a fresh 24-word testnet deployer wallet. Run from the repo root.
// Writes the mnemonic into settings/Testnet.toml (seeding it from a template if
// absent, since it is gitignored) for clarinet to read, and mirrors it into .env.
// The mnemonic is never printed. Refuses to overwrite an existing real mnemonic
// unless FORCE=1, so re-running can't silently orphan funds.
//
//   node scripts/gen-deployer.mjs          # first run
//   FORCE=1 node scripts/gen-deployer.mjs  # rotate the wallet
//
// The deployer ADDRESS is not derived here; run
//   clarinet deployments generate --testnet
// afterward and read `expected-sender` from the generated plan (authoritative).
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

const TESTNET_TOML = "settings/Testnet.toml";
const ENV = ".env";
const PLACEHOLDER = "<YOUR PRIVATE TESTNET MNEMONIC HERE>";
const force = process.env.FORCE === "1";

// Paths are cwd-relative (repo convention: scripts run from the repo root). Bail with a
// clear message if we're elsewhere, instead of reading/writing the wrong files.
if (!existsSync("Clarinet.toml")) {
  console.error("Run this from the repo root (no Clarinet.toml in the current directory).");
  process.exit(1);
}

// settings/Testnet.toml is gitignored, so it is absent on a fresh clone. Seed a
// minimal template carrying the PLACEHOLDER, which flows straight into the fill
// logic below -- so this script works standalone without running clarinet first.
const TESTNET_TEMPLATE = `[network]
name = "testnet"
stacks_node_rpc_address = "https://api.testnet.hiro.so"
deployment_fee_rate = 10

[accounts.deployer]
mnemonic = "${PLACEHOLDER}"
`;

const toml = existsSync(TESTNET_TOML) ? readFileSync(TESTNET_TOML, "utf8") : TESTNET_TEMPLATE;
if (!toml.includes(PLACEHOLDER) && !force) {
  console.error(
    `Refusing to overwrite: ${TESTNET_TOML} already holds a real mnemonic. Set FORCE=1 to rotate the wallet.`,
  );
  process.exit(1);
}

const mnemonic = generateMnemonic(wordlist, 256); // 256 bits of entropy -> 24 words

// settings/Testnet.toml: replace the single `mnemonic = "..."` line value.
const updatedToml = toml.replace(/^mnemonic = ".*"$/m, `mnemonic = "${mnemonic}"`);
if (updatedToml === toml) {
  console.error(`Could not find a 'mnemonic = "..."' line in ${TESTNET_TOML}; aborting.`);
  process.exit(1);
}
// 0o600: the mnemonic is a seed phrase, so keep these files owner-readable only.
// writeFileSync's mode applies on creation; chmod enforces it on a pre-existing file.
mkdirSync(dirname(TESTNET_TOML), { recursive: true });
writeFileSync(TESTNET_TOML, updatedToml, { mode: 0o600 });
chmodSync(TESTNET_TOML, 0o600);

// .env: replace or append DEPLOYER_MNEMONIC, leaving every other key (e.g. PYTH_API_KEY) intact.
let env = existsSync(ENV) ? readFileSync(ENV, "utf8") : "";
env = env.replace(/^DEPLOYER_MNEMONIC=.*$\n?/m, "");
if (env.length && !env.endsWith("\n")) env += "\n";
env += `DEPLOYER_MNEMONIC="${mnemonic}"\n`;
writeFileSync(ENV, env, { mode: 0o600 });
chmodSync(ENV, 0o600);

console.log("Generated a fresh 24-word deployer mnemonic (value not printed).");
console.log(`  -> ${TESTNET_TOML} (mnemonic, clarinet reads this)`);
console.log(`  -> ${ENV} (DEPLOYER_MNEMONIC)`);
console.log("Next: clarinet deployments generate --testnet --low-cost");
