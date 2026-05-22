#!/usr/bin/env node
/**
 * pretty.mjs — human-friendly wrapper around the orchestrator.
 *
 * Spawns `tsx src/index.ts` with the args you pass, captures its JSON stage
 * events on stdout, and renders them as colored, boxed terminal output. Use
 * this for manual / video runs. The plain `npm run demo` script keeps its
 * raw JSON output for agent consumption (don't break that contract).
 *
 * Forwards exit code and SIGINT to the child.
 *
 * Usage:
 *   npm run pretty -- --amount 100000000000000
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));

// ── ANSI helpers ────────────────────────────────────────────────────────────
const ansi = (code) => (s) => `\x1b[${code}m${s}\x1b[0m`;
const dim     = ansi(2);
const bold    = ansi(1);
const red     = ansi(31);
const green   = ansi(32);
const yellow  = ansi(33);
const blue    = ansi(34);
const magenta = ansi(35);
const cyan    = ansi(36);
const gray    = ansi(90);

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const visLen = (s) => stripAnsi(s).length;

const BOX_W = 72;
function box(title, color, lines) {
  const titleLine = ` ${title} `;
  const topPad = "═".repeat(Math.max(0, BOX_W - 2 - titleLine.length));
  console.log(color(`╔${titleLine}${topPad}╗`));
  console.log(color(`║${" ".repeat(BOX_W - 2)}║`));
  for (const line of lines) {
    const pad = Math.max(1, BOX_W - 4 - visLen(line));
    console.log(`${color("║")} ${line}${" ".repeat(pad)} ${color("║")}`);
  }
  console.log(color(`║${" ".repeat(BOX_W - 2)}║`));
  console.log(color(`╚${"═".repeat(BOX_W - 2)}╝`));
}

function header(text, color = cyan) {
  console.log();
  console.log(color(`──── ${text} ${"─".repeat(Math.max(0, BOX_W - 7 - text.length))}`));
}

function shortLong(a) {
  if (typeof a !== "string") return String(a);
  if (a.startsWith("0zk1") && a.length > 30) return `${a.slice(0, 16)}…${a.slice(-8)}`;
  return a;
}

function fmtEth(weiStr, unit = "ETH") {
  try {
    const wei = BigInt(weiStr);
    const eth = Number(wei) / 1e18;
    return `${eth.toFixed(8)} ${unit}`;
  } catch {
    return `${weiStr} wei`;
  }
}

// ── event renderer ──────────────────────────────────────────────────────────
function render(evt) {
  switch (evt.stage) {
    case "state.uninitialized":
      header(evt.stage);
      console.log("First run — generating three fresh wallets locally.");
      return;

    case "state.initialized":
      header(evt.stage, green);
      console.log(`${green("✓")} Three wallets generated. Secrets in ${cyan("state/wallets.json")}.`);
      console.log();
      console.log(`  ${bold("Broadcaster")}  (Sepolia)      ${cyan(evt.broadcasterAddress)}`);
      console.log(`  ${bold("Dest EOA")}     (Arb Sepolia)  ${cyan(evt.destAddress)}`);
      console.log(`  ${bold("0zk wallet")}                  ${cyan(shortLong(evt.railgunZkAddress))}`);
      console.log();
      box("ACTION REQUIRED  ·  fund the demo wallets", yellow, [
        `${bold("Send")} ${yellow(fmtEth(evt.recommendedSourceFundingWei))} ${dim("→")} broadcaster (Sepolia)`,
        `${bold("Send")} ${yellow(fmtEth(evt.recommendedDestFundingWei))} ${dim("→")} dest EOA (Arb Sepolia)`,
        ``,
        `Tip: ${cyan("npm run rebalance")} in another terminal does both at once.`,
        `When funded, re-run the same command.`
      ]);
      return;

    case "state.probing_shield":
      header(evt.stage);
      console.log("Checking 0zk wallet for existing shielded balance…");
      return;

    case "state.shield_probe": {
      header(evt.stage);
      const have = fmtEth(evt.shieldedWei, "WETH");
      const need = fmtEth(evt.minSpendableWei, "WETH");
      if (evt.alreadyShielded) {
        console.log(`${green("✓")} Already shielded ${green(have)} ${dim(`(≥ ${need} needed)`)}. Skipping re-shield.`);
      } else {
        console.log(`Have ${have}, need ≥ ${need}. Will shield more.`);
      }
      return;
    }

    case "state.shielding":
      header(evt.stage);
      console.log(`Shielding ${bold(fmtEth(evt.targetShieldedWei))} into the 0zk wallet…`);
      console.log(dim("(one Sepolia tx + Railgun balance scan)"));
      return;

    case "state.shielded":
      header(evt.stage, green);
      if (evt.reused) {
        console.log(`${green("✓")} Reusing existing shielded balance: ${green(fmtEth(evt.shieldedWei, "WETH"))}`);
      } else {
        console.log(`${green("✓")} Shielded ${green(fmtEth(evt.shieldedWei, "WETH"))}`);
        console.log(`    ${dim("tx")}    ${cyan(evt.shieldTxHash)}`);
        console.log(`    ${dim("block")} ${evt.block}`);
      }
      return;

    case "state.awaiting_source_funding":
      header(evt.stage, yellow);
      box("ACTION REQUIRED  ·  top up broadcaster", yellow, [
        `Address ${dim("(Sepolia)")}  ${cyan(evt.address)}`,
        ``,
        `Current  ${fmtEth(evt.currentWei)}`,
        `Required ${fmtEth(evt.requiredWei)}`,
        `${red(bold("Shortfall"))} ${red(fmtEth(evt.shortfallWei))}`,
        ``,
        `Tip: ${cyan("npm run rebalance")} in another terminal will fund both.`,
        `When funded, re-run the same command.`
      ]);
      return;

    case "state.awaiting_dest_funding":
      header(evt.stage, yellow);
      box("ACTION REQUIRED  ·  top up dest EOA", yellow, [
        `Address ${dim("(Arb Sepolia)")}  ${cyan(evt.address)}`,
        ``,
        `Current  ${fmtEth(evt.currentWei)}`,
        `Required ${fmtEth(evt.requiredWei)}`,
        `${red(bold("Shortfall"))} ${red(fmtEth(evt.shortfallWei))}`,
        ``,
        `Tip: ${cyan("npm run rebalance")} in another terminal will fund both.`,
        `When funded, re-run the same command.`
      ]);
      return;

    case "state.ready":
      header(evt.stage, green);
      console.log(`${green("✓")} All funded. Bridging ${green(fmtEth(evt.amountWei))} now.`);
      return;

    case "quote.requesting":
      header(evt.stage);
      console.log(`Requesting quote for ${bold(fmtEth(evt.amountWei))} from Train solver network…`);
      return;

    case "quote.received": {
      header(evt.stage, green);
      console.log(`${green("✓")} Quote from ${bold(evt.solverName)}`);
      console.log(`    ${dim("receive")} ${green(fmtEth(evt.receiveAmount))}`);
      console.log(`    ${dim("reward ")} ${fmtEth(evt.rewardAmount)}`);
      const sec = evt.quoteExpiry - Math.floor(Date.now() / 1000);
      console.log(`    ${dim("expires in")} ${sec}s`);
      return;
    }

    case "source.locking":
      header(evt.stage, magenta);
      console.log(`${magenta("→")} Generating Railgun ZK proof (~30–60s). ${bold("This is the privacy layer.")}`);
      console.log(`    ${dim(`quote good for ${evt.secondsToProof}s`)}`);
      return;

    case "source.locked":
      header(evt.stage, magenta);
      console.log(`${magenta("★")} ${bold("Sepolia source lock landed.")}`);
      console.log(`    ${dim("tx       ")} ${cyan(evt.sourceTxHash)}`);
      console.log(`    ${dim("hashlock ")} ${dim(evt.hashlock)}`);
      console.log(`    ${dim("HTLC     ")} ${dim(evt.trainAddress)}`);
      console.log(`    ${dim("block    ")} ${evt.blockNumber}`);
      console.log();
      console.log(`    ${dim("Open the tx on Etherscan: tx.from is the anonymous broadcaster,")}`);
      console.log(`    ${dim("tx.to is Railgun Relay Adapt — funds came out of the merkletree.")}`);
      return;

    case "dest.polling":
      header(evt.stage);
      console.log(`Polling Arb Sepolia for solver match… ${dim(`(hashlock ${evt.hashlock.slice(0, 18)}…)`)}`);
      return;

    case "dest.redeemed":
      header(evt.stage, green);
      console.log(`${green("✓")} ${bold("Redeemed on Arb Sepolia.")}`);
      console.log(`    ${dim("tx        ")} ${cyan(evt.redeemTxHash)}`);
      console.log(`    ${dim("recipient ")} ${cyan(evt.recipient)}`);
      console.log();
      console.log(`    ${dim("Secret is now public on Arb Sepolia. The solver will use it")}`);
      console.log(`    ${dim("to redeem the Sepolia side and recoup their capital.")}`);
      return;

    case "done":
      console.log();
      box("BRIDGE COMPLETE", green, [
        `${bold("source tx")} ${dim("(Sepolia)")}    ${cyan(evt.sourceTx)}`,
        `${bold("dest tx ")} ${dim("(Arb Sepolia)")} ${cyan(evt.destTx)}`,
        `${bold("hashlock")}                  ${dim(evt.hashlock)}`,
        ``,
        `${green("Three fresh keys, three roles, zero correlation surface.")}`
      ]);
      return;

    case "error":
      header(evt.stage, red);
      console.log(`${red("✗")} ${evt.message}`);
      return;

    default:
      console.log(dim(JSON.stringify(evt)));
  }
}

// ── child process ───────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const child = spawn("npx", ["tsx", "src/index.ts", ...args], {
  cwd: SKILL_DIR,
  shell: true,
  stdio: ["inherit", "pipe", "pipe"]
});

const out = createInterface({ input: child.stdout });
out.on("line", (line) => {
  let evt;
  try {
    evt = JSON.parse(line);
  } catch {
    // Non-JSON line — Railgun PROOF %, polling counters, etc. Forward as gray.
    if (line.trim()) process.stdout.write(`${gray(line)}\n`);
    return;
  }
  if (evt && typeof evt === "object" && typeof evt.stage === "string") {
    render(evt);
  } else {
    process.stdout.write(`${gray(line)}\n`);
  }
});

const err = createInterface({ input: child.stderr });
err.on("line", (line) => {
  if (line.trim()) process.stderr.write(`${gray(line)}\n`);
});

child.on("exit", (code) => {
  console.log();
  process.exit(code ?? 1);
});

process.on("SIGINT", () => {
  child.kill("SIGINT");
});
