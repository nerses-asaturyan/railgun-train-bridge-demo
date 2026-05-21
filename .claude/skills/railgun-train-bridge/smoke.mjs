#!/usr/bin/env node
/**
 * railgun-train-bridge — pre-flight smoke.
 *
 * Verifies the environment without touching the user's testnet funds:
 *   1. Node >= 20
 *   2. POI aggregator (ppoi.fdi.network) responds to ppoi_validated_txid
 *   3. Train solver API (train-solver-station.dev.lb.layerswap.cloud)
 *      returns a quote for 0.0001 ETH Sepolia -> Arb Sepolia
 *   4. TypeScript compiles (tsc --noEmit)
 *   5. The orchestrator runs end-to-end up to state.initialized and
 *      writes three valid wallet addresses to state/wallets.json
 *
 * Exits non-zero on any failure. Leaves state/ wiped so a real demo run
 * picks up cleanly afterward. No on-chain txs; no funds spent.
 *
 * Prereq: `npm install` has been run in this directory.
 * Run from the skill dir: `node smoke.mjs` (or `npm run smoke`).
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(SKILL_DIR, "state");

const POI_URL = "https://ppoi.fdi.network";
const TRAIN_SOLVER_BASE = "https://train-solver-station.dev.lb.layerswap.cloud";
const SEPOLIA_CHAIN_ID = "11155111";
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const SMOKE_AMOUNT_WEI = "100000000000000"; // 0.0001 ETH

const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
let failed = 0;
async function step(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try {
    const detail = await fn();
    console.log(`${PASS}${detail ? "  " + detail : ""}`);
  } catch (e) {
    failed++;
    console.log(`${FAIL}  ${e.message}`);
  }
}

console.log("\nrailgun-train-bridge :: pre-flight smoke\n");

console.log("environment");
await step("Node >= 20", () => {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (major < 20) throw new Error(`have ${process.versions.node}, need >= 20`);
  return `(${process.versions.node})`;
});

console.log("\nexternal dependencies");
await step("POI aggregator responds", async () => {
  const r = await fetch(POI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "ppoi_validated_txid",
      params: { chainType: "0", chainID: SEPOLIA_CHAIN_ID, txidVersion: "V2_PoseidonMerkle" },
      id: 1
    })
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!j.result?.validatedTxidIndex) throw new Error("no validatedTxidIndex in response");
  return `(idx ${j.result.validatedTxidIndex})`;
});

await step("Train solver API returns a quote", async () => {
  const params = new URLSearchParams({
    amount: SMOKE_AMOUNT_WEI,
    sourceNetwork: "eip155:11155111",
    destinationNetwork: "eip155:421614",
    sourceTokenContract: ZERO_ADDR,
    destinationTokenContract: ZERO_ADDR,
    includeReward: "true"
  });
  const r = await fetch(`${TRAIN_SOLVER_BASE}/api/v1/quote?${params}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const quotes = j.data?.quotes ?? [];
  if (!quotes.length) throw new Error(`no quotes (errors=${JSON.stringify(j.data?.errors ?? [])})`);
  const q = quotes.find((qq) => qq.quote) ?? quotes[0];
  return `(${q.solver?.name}: ${q.quote?.receiveAmount} wei out)`;
});

console.log("\nsource");
await step("tsc --noEmit", () => {
  const r = spawnSync("npm", ["run", "check"], { cwd: SKILL_DIR, shell: true });
  if (r.status !== 0) {
    const tail = (r.stdout?.toString() + r.stderr?.toString()).slice(-300);
    throw new Error(`non-zero exit: ${tail.trim()}`);
  }
});

console.log("\norchestrator");
if (existsSync(STATE_DIR)) rmSync(STATE_DIR, { recursive: true, force: true });

await step("npm run demo -> state.initialized", async () => {
  const lines = [];
  const proc = spawn("npm", ["run", "demo", "--", "--amount", SMOKE_AMOUNT_WEI], {
    cwd: SKILL_DIR,
    shell: true
  });
  proc.stdout.on("data", (d) => {
    lines.push(...d.toString().split(/\r?\n/).filter(Boolean));
  });
  await new Promise((res, rej) => {
    proc.on("close", (code) => (code === 0 ? res() : rej(new Error(`exit ${code}`))));
    proc.on("error", rej);
  });
  const events = lines
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.stage);
  const init = events.find((e) => e.stage === "state.initialized");
  if (!init) {
    const seen = events.map((e) => e.stage).join(", ");
    throw new Error(`no state.initialized event; saw [${seen}]`);
  }
  const isAddr = (s) => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
  if (!isAddr(init.broadcasterAddress)) throw new Error(`bad broadcasterAddress: ${init.broadcasterAddress}`);
  if (!isAddr(init.destAddress)) throw new Error(`bad destAddress: ${init.destAddress}`);
  if (!init.railgunZkAddress?.startsWith("0zk1")) {
    throw new Error(`bad railgunZkAddress: ${init.railgunZkAddress}`);
  }
  return `(broadcaster ${init.broadcasterAddress.slice(0, 10)}...)`;
});

if (existsSync(STATE_DIR)) rmSync(STATE_DIR, { recursive: true, force: true });

console.log();
if (failed) {
  console.log(`\x1b[31m${failed} failed.\x1b[0m\n`);
  process.exit(1);
}
console.log("\x1b[32mAll checks passed.\x1b[0m\n");
