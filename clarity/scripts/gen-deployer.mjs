#!/usr/bin/env node
// One-shot: generate a fresh 24-word testnet deployer wallet. Writes the mnemonic
// into settings/Testnet.toml (which clarinet reads to derive the deployer) and
// mirrors it into .env. The mnemonic is never printed. Refuses to overwrite an
// existing real mnemonic unless FORCE=1, so re-running can't silently orphan funds.
//
//   node scripts/gen-deployer.mjs          # first run
//   FORCE=1 node scripts/gen-deployer.mjs  # rotate the wallet
//
// The deployer ADDRESS is not derived here; run
//   clarinet deployments generate --testnet
// afterward and read `expected-sender` from the generated plan (authoritative).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

const TESTNET_TOML = "settings/Testnet.toml";
const ENV = ".env";
const PLACEHOLDER = "<YOUR PRIVATE TESTNET MNEMONIC HERE>";
const force = process.env.FORCE === "1";

const toml = readFileSync(TESTNET_TOML, "utf8");
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
writeFileSync(TESTNET_TOML, updatedToml);

// .env: replace or append DEPLOYER_MNEMONIC, leaving every other key (e.g. PYTH_API_KEY) intact.
let env = existsSync(ENV) ? readFileSync(ENV, "utf8") : "";
env = env.replace(/^DEPLOYER_MNEMONIC=.*$\n?/m, "");
if (env.length && !env.endsWith("\n")) env += "\n";
env += `DEPLOYER_MNEMONIC="${mnemonic}"\n`;
writeFileSync(ENV, env);

console.log("Generated a fresh 24-word deployer mnemonic (value not printed).");
console.log(`  -> ${TESTNET_TOML} (mnemonic, clarinet reads this)`);
console.log(`  -> ${ENV} (DEPLOYER_MNEMONIC)`);
console.log("Next: clarinet deployments generate --testnet --low-cost");
