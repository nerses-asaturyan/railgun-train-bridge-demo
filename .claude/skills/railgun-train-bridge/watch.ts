/**
 * watch.ts — live-refreshing balance dashboard for the railgun-train-bridge demo.
 *
 * Polls every 5s and renders:
 *   Sepolia: funder + broadcaster + 0zk shielded WETH + Train HTLC
 *   Arb Sepolia: funder + dest + Train HTLC
 *
 * The 0zk shielded balance requires booting the Railgun engine — the first
 * tick takes ~5s; subsequent ticks are fast. Funder rows only render if
 * FUNDING_PRIVATE_KEY is set in the environment.
 *
 * Usage:
 *   npm run watch
 *
 * Optional env:
 *   FUNDING_PRIVATE_KEY=0x...   show funder rows
 *   POLL_INTERVAL_MS=1500       override poll cadence (default 500)
 */

import { existsSync } from "node:fs";
import { JsonRpcProvider, Wallet, formatEther } from "ethers";

import { probeShieldedTotalBalance } from "./src/bootstrap.js";
import { ARB_SEPOLIA, SEPOLIA, TRAIN_SOLVER_API } from "./src/networks.js";
import { WALLETS_PATH, loadWallets } from "./src/state.js";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 500);

if (!existsSync(WALLETS_PATH)) {
  console.error(`ERROR: ${WALLETS_PATH} not found.`);
  console.error("Run `npm run demo -- --amount <wei>` first to generate the demo wallets.");
  process.exit(1);
}

const wallets = await loadWallets();
const broadcaster = new Wallet(wallets.broadcasterPrivateKey).address;
const dest = new Wallet(wallets.destPrivateKey).address;
const zkAddr = wallets.railgunZkAddress;

const funderPk = process.env.FUNDING_PRIVATE_KEY;
const funder = funderPk ? new Wallet(funderPk).address : null;

console.log("Resolving Train HTLC addresses from solver API...");
const trainContracts = await resolveTrainContracts();
console.log(`  Sepolia      ${trainContracts.sep ?? "(not found)"}`);
console.log(`  Arb Sepolia  ${trainContracts.arb ?? "(not found)"}`);
console.log();
console.log("Booting Railgun engine for shielded balance reads (first tick ~5s)...");

const sepProvider = new JsonRpcProvider(SEPOLIA.rpc, SEPOLIA.chainId);
const arbProvider = new JsonRpcProvider(ARB_SEPOLIA.rpc, ARB_SEPOLIA.chainId);

await tick();
setInterval(() => { void tick(); }, POLL_INTERVAL_MS);

async function tick(): Promise<void> {
  try {
    const [sepBroadcaster, sepFunder, sepTrain, arbDest, arbFunder, arbTrain, shielded] =
      await Promise.all([
        sepProvider.getBalance(broadcaster),
        funder ? sepProvider.getBalance(funder) : Promise.resolve(0n),
        trainContracts.sep ? sepProvider.getBalance(trainContracts.sep) : Promise.resolve(0n),
        arbProvider.getBalance(dest),
        funder ? arbProvider.getBalance(funder) : Promise.resolve(0n),
        trainContracts.arb ? arbProvider.getBalance(trainContracts.arb) : Promise.resolve(0n),
        probeShieldedTotalBalance(wallets)
      ]);

    process.stdout.write("\x1b[2J\x1b[H");
    const now = new Date().toLocaleTimeString();
    console.log(`railgun-train-bridge :: live balance watch        ${now}`);
    console.log(`(refreshes every ${POLL_INTERVAL_MS / 1000}s — Ctrl-C to stop)\n`);

    console.log("\x1b[36mSepolia\x1b[0m");
    if (funder) row("funder", funder, sepFunder, "ETH");
    row("broadcaster", broadcaster, sepBroadcaster, "ETH");
    rowNamed("0zk shielded WETH", zkAddr, shielded, "WETH", true);
    if (trainContracts.sep) row("Train HTLC", trainContracts.sep, sepTrain, "ETH");

    console.log();
    console.log("\x1b[36mArbitrum Sepolia\x1b[0m");
    if (funder) row("funder", funder, arbFunder, "ETH");
    row("dest", dest, arbDest, "ETH");
    if (trainContracts.arb) row("Train HTLC", trainContracts.arb, arbTrain, "ETH");
  } catch (e) {
    console.error(`\n[poll error: ${(e as Error).message}]`);
  }
}

const LABEL_W = 20;
const ID_W = 22;

function row(label: string, addr: string, wei: bigint, unit: string): void {
  console.log(
    `  ${label.padEnd(LABEL_W)} ${shortAddr(addr).padEnd(ID_W)} ${fmtEth(wei).padStart(14)} ${unit}`
  );
}

function rowNamed(label: string, fullId: string, wei: bigint, unit: string, longId: boolean): void {
  const id = longId ? fullId.slice(0, ID_W - 1) + "…" : shortAddr(fullId);
  console.log(
    `  ${label.padEnd(LABEL_W)} ${id.padEnd(ID_W)} ${fmtEth(wei).padStart(14)} ${unit}`
  );
}

function fmtEth(wei: bigint): string {
  return Number(formatEther(wei)).toFixed(6);
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

async function resolveTrainContracts(): Promise<{ sep?: string; arb?: string }> {
  try {
    const r = await fetch(`${TRAIN_SOLVER_API}/api/v1/networks`);
    if (!r.ok) return {};
    const j = (await r.json()) as { data?: unknown };
    const data = j.data;
    if (!data) return {};
    const arr: { caip2Id?: string; trainContract?: string }[] = Array.isArray(data)
      ? (data as never)
      : ((data as { networks?: unknown }).networks as never) ?? [];
    const sep = arr.find((n) => n.caip2Id === "eip155:11155111");
    const arb = arr.find((n) => n.caip2Id === "eip155:421614");
    return { sep: sep?.trainContract, arb: arb?.trainContract };
  } catch {
    return {};
  }
}
