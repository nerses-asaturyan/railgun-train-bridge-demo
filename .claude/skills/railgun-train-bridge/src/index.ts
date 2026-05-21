/**
 * Railgun + Train Bridge — self-contained skill orchestrator.
 *
 * Re-entrant state machine. Each invocation:
 *   1. Reads state/wallets.json + state/shield.json (if present)
 *   2. Decides the current state (uninitialized / awaiting funding / shielding / ready)
 *   3. Either advances one step or emits an "awaiting" milestone and exits 0
 *
 * The skill's Claude narration loop: any `state.awaiting_*` event means stop,
 * narrate funding instructions, wait for the operator to fund + say "continue",
 * then re-run the same command. State persistence makes this safe.
 *
 * Usage:
 *   npx tsx src/index.ts --amount 100000000000000
 *   npx tsx src/index.ts --reset                # wipe state/ and exit
 */

import { Wallet } from "ethers";

import {
  ARB_SEPOLIA_CHAIN_ID,
  SEPOLIA_CHAIN_ID
} from "./networks.js";
import { shutdownRailgun } from "./railgun-common.js";
import {
  checkDestFunding,
  checkSourceFunding,
  destFundingFor,
  ensureShielded,
  initFreshWallets,
  minSpendableShieldedFor,
  probeShieldedBalance,
  shieldAmountFor,
  sourceFundingFor
} from "./bootstrap.js";
import { hasWallets, loadWallets, STATE_DIR, wipeState } from "./state.js";
import { fetchBestQuote } from "./quote.js";
import { buildAndBroadcastRailgunLock } from "./lock-railgun.js";
import { pollAndRedeem } from "./poll-and-redeem.js";

type Args = {
  amountWei: bigint;
  reset: boolean;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let amount = 100_000_000_000_000n; // 0.0001 ETH default
  let reset = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--amount" && argv[i + 1]) {
      amount = BigInt(argv[i + 1]);
      i++;
    } else if (argv[i] === "--reset") {
      reset = true;
    }
  }
  return { amountWei: amount, reset };
}

function emit(stage: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ stage, ...data }));
}

async function runReset() {
  await wipeState();
  emit("state.reset", { statePath: STATE_DIR });
}

async function main() {
  const args = parseArgs();

  if (args.reset) {
    await runReset();
    return;
  }

  // --------------------------------------------------------------- bootstrap
  if (!hasWallets()) {
    emit("state.uninitialized", { statePath: STATE_DIR });
    const wallets = await initFreshWallets();
    emit("state.initialized", {
      statePath: STATE_DIR,
      broadcasterAddress: new Wallet(wallets.broadcasterPrivateKey).address,
      destAddress: new Wallet(wallets.destPrivateKey).address,
      railgunZkAddress: wallets.railgunZkAddress,
      railgunCreationBlock: wallets.railgunCreationBlock,
      recommendedSourceFundingWei: sourceFundingFor(args.amountWei).toString(),
      recommendedDestFundingWei: destFundingFor().toString(),
      sourceChain: "sepolia",
      destChain: "arb_sepolia",
      note: "Fund both addresses, then re-run the same command to continue."
    });
    return;
  }

  const wallets = await loadWallets();
  const broadcasterAddress = new Wallet(wallets.broadcasterPrivateKey).address;
  const destAddress = new Wallet(wallets.destPrivateKey).address;

  // ----------------------------------- probe existing shielded balance first
  // If the 0zk wallet already holds enough spendable WETH to cover the lock
  // (bridge amount + 25 bps unshield fee), the broadcaster only needs lock-tx
  // gas — not the full shield budget.
  emit("state.probing_shield", {});
  const shieldedBalance = await probeShieldedBalance(wallets);
  const minSpendableWei = minSpendableShieldedFor(args.amountWei);
  const alreadyShielded = shieldedBalance >= minSpendableWei;
  emit("state.shield_probe", {
    shieldedWei: shieldedBalance.toString(),
    minSpendableWei: minSpendableWei.toString(),
    grossShieldTargetWei: shieldAmountFor(args.amountWei).toString(),
    alreadyShielded
  });

  // -------------------------------------------------- check source funding
  const sourceStatus = await checkSourceFunding(args.amountWei, wallets, alreadyShielded);
  if (sourceStatus.kind === "short") {
    emit("state.awaiting_source_funding", {
      chain: "sepolia",
      chainId: SEPOLIA_CHAIN_ID,
      address: broadcasterAddress,
      currentWei: sourceStatus.balanceWei.toString(),
      requiredWei: sourceStatus.requiredWei.toString(),
      shortfallWei: sourceStatus.shortfallWei.toString(),
      note: "Send the shortfall (or more) to the broadcaster address, then re-run."
    });
    return;
  }

  // -------------------------------------------------------- shield if needed
  emit("state.shielding", {
    targetShieldedWei: shieldAmountFor(args.amountWei).toString()
  });
  const shieldResult = await ensureShielded(args.amountWei, wallets, (msg) =>
    process.stderr.write(`[shield] ${msg}\n`)
  );
  if (shieldResult.kind === "already-shielded") {
    emit("state.shielded", {
      reused: true,
      shieldedWei: shieldResult.shieldedWei.toString()
    });
  } else {
    emit("state.shielded", {
      reused: false,
      shieldTxHash: shieldResult.txHash,
      shieldedWei: shieldResult.shieldedWei.toString(),
      block: shieldResult.block
    });
  }

  // ---------------------------------------------------- check dest funding
  const destStatus = await checkDestFunding(wallets);
  if (destStatus.kind === "short") {
    emit("state.awaiting_dest_funding", {
      chain: "arb_sepolia",
      chainId: ARB_SEPOLIA_CHAIN_ID,
      address: destAddress,
      currentWei: destStatus.balanceWei.toString(),
      requiredWei: destStatus.requiredWei.toString(),
      shortfallWei: destStatus.shortfallWei.toString(),
      note: "Send the shortfall (or more) to the dest address on Arb Sepolia, then re-run."
    });
    return;
  }

  emit("state.ready", {
    amountWei: args.amountWei.toString(),
    broadcasterAddress,
    destAddress
  });

  // -------------------------------------------------------- existing flow
  emit("quote.requesting", { amountWei: args.amountWei.toString() });
  const quote = await fetchBestQuote({ amountWei: args.amountWei });
  emit("quote.received", {
    solverId: quote.solverId,
    solverName: quote.solverName,
    receiveAmount: quote.details.receiveAmount,
    rewardAmount: quote.details.reward.amount,
    quoteExpiry: quote.details.quoteExpirationTimestampInSeconds,
    timelockDelta: quote.details.timelockTimeSpanInSeconds,
    sourceSolver: quote.details.sourceSolverAddress,
    destinationSolver: quote.details.destinationSolverAddress
  });

  const secondsLeft =
    quote.details.quoteExpirationTimestampInSeconds - Math.floor(Date.now() / 1000);
  if (secondsLeft < 90) {
    throw new Error(
      `Quote expires in ${secondsLeft}s; ZK proof gen takes 30-60s. Refusing to start.`
    );
  }

  emit("source.locking", { secondsToProof: secondsLeft });
  const lockResult = await buildAndBroadcastRailgunLock(quote, args.amountWei);
  emit("source.locked", {
    hashlock: lockResult.hashlock,
    trainAddress: lockResult.trainAddress,
    sourceTxHash: lockResult.sourceTxHash,
    blockNumber: lockResult.blockNumber
  });

  emit("dest.polling", { hashlock: lockResult.hashlock });
  const redeemResult = await pollAndRedeem({
    hashlock: lockResult.hashlock,
    secret: lockResult.secret
  });
  emit("dest.redeemed", {
    solverLockIndex: redeemResult.solverLock.index,
    redeemTxHash: redeemResult.redeemTxHash,
    recipient: destAddress
  });

  emit("done", {
    hashlock: lockResult.hashlock,
    sourceTx: lockResult.sourceTxHash,
    destTx: redeemResult.redeemTxHash,
    note: "Solver should now redeem the source lock automatically using the on-chain-revealed secret."
  });
}

main()
  .then(async () => {
    await shutdownRailgun();
    process.exit(0);
  })
  .catch(async (err) => {
    const message = err instanceof Error ? err.message : String(err);
    emit("error", { message });
    if (process.env.RAILGUN_DEBUG === "1" && err instanceof Error && err.stack) {
      process.stderr.write(err.stack + "\n");
    }
    await shutdownRailgun();
    process.exit(1);
  });
