#!/usr/bin/env node
/**
 * rebalance.mjs — top up the demo's broadcaster (Sepolia) and dest (Arb Sepolia)
 * wallets from a single funding key. One key signs on both chains.
 *
 * Reads state/wallets.json for the demo addresses (so you must have run the
 * demo at least once to generate them). Sends the recommended funding amounts
 * by default; override with --source-eth / --dest-eth.
 *
 * Requires FUNDING_PRIVATE_KEY in the environment:
 *
 *   PowerShell:   $env:FUNDING_PRIVATE_KEY = '0x...'
 *   bash/zsh:     export FUNDING_PRIVATE_KEY='0x...'
 *
 * Usage:
 *   npm run rebalance
 *   npm run rebalance -- --source-eth 0.02 --dest-eth 0.002
 */

import { readFile } from "node:fs/promises";
import { JsonRpcProvider, Wallet, formatEther, parseEther } from "ethers";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));
const WALLETS_PATH = resolve(SKILL_DIR, "state", "wallets.json");

// Mirror src/networks.ts. Hardcoded here so this script runs as plain JS
// without needing tsx to resolve TypeScript imports.
const SEPOLIA = { chainId: 11_155_111, rpc: "https://ethereum-sepolia-rpc.publicnode.com", label: "Sepolia" };
const ARB_SEPOLIA = { chainId: 421_614, rpc: "https://sepolia-rollup.arbitrum.io/rpc", label: "Arb Sepolia" };

const args = process.argv.slice(2);
const flagValue = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 || !args[i + 1] ? dflt : args[i + 1];
};
const SOURCE_ETH = flagValue("source-eth", "0.011");
const DEST_ETH = flagValue("dest-eth", "0.001");

const FUNDING_PK = process.env.FUNDING_PRIVATE_KEY;
if (!FUNDING_PK) {
  console.error("ERROR: FUNDING_PRIVATE_KEY env var is not set.");
  console.error("  PowerShell:  $env:FUNDING_PRIVATE_KEY = '0x...'");
  console.error("  bash/zsh:    export FUNDING_PRIVATE_KEY='0x...'");
  process.exit(1);
}

let wallets;
try {
  wallets = JSON.parse(await readFile(WALLETS_PATH, "utf8"));
} catch {
  console.error(`ERROR: ${WALLETS_PATH} not found.`);
  console.error("Run `npm run demo -- --amount <wei>` first to generate the demo wallets.");
  process.exit(1);
}

const broadcaster = new Wallet(wallets.broadcasterPrivateKey).address;
const dest = new Wallet(wallets.destPrivateKey).address;
const funder = new Wallet(FUNDING_PK).address;

console.log("Rebalance plan:");
console.log(`  funder       ${funder}`);
console.log(`  broadcaster  ${broadcaster}  (Sepolia)    <- ${SOURCE_ETH} ETH`);
console.log(`  dest         ${dest}  (Arb Sepolia) <- ${DEST_ETH} ETH`);
console.log();

async function fundOn(chain, recipient, ethAmount) {
  const provider = new JsonRpcProvider(chain.rpc, chain.chainId);
  const wallet = new Wallet(FUNDING_PK, provider);
  const balance = await provider.getBalance(wallet.address);
  const value = parseEther(ethAmount);
  console.log(`[${chain.label}] funder balance ${formatEther(balance)} ETH`);
  if (balance < value) {
    throw new Error(
      `[${chain.label}] funder balance ${formatEther(balance)} ETH < required ${ethAmount} ETH. Top up the funder first.`
    );
  }
  console.log(`[${chain.label}] sending ${ethAmount} ETH -> ${recipient}`);
  const tx = await wallet.sendTransaction({ to: recipient, value });
  console.log(`[${chain.label}] tx ${tx.hash}, waiting for inclusion...`);
  const receipt = await tx.wait();
  console.log(`[${chain.label}] confirmed in block ${receipt.blockNumber}`);
}

try {
  await fundOn(SEPOLIA, broadcaster, SOURCE_ETH);
  console.log();
  await fundOn(ARB_SEPOLIA, dest, DEST_ETH);
  console.log();
  console.log("Done. Re-run `npm run demo -- --amount <wei>` to continue the bridge.");
} catch (e) {
  console.error(`\nERROR: ${e.message}`);
  process.exit(1);
}
