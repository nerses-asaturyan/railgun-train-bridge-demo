import { randomBytes } from "node:crypto";

import {
  EvmHTLCWalletClient,
  registerEvmSdk
} from "@train-protocol/evm";
import type { UserLockParams } from "@train-protocol/sdk";
import { Contract, JsonRpcProvider, formatEther, sha256, toBeHex, Wallet } from "ethers";

import {
  balanceForERC20Token,
  createRailgunWallet,
  fullWalletForID,
  gasEstimateForUnprovenCrossContractCalls,
  generateCrossContractCallsProof,
  populateProvedCrossContractCalls,
  refreshBalances
} from "@railgun-community/wallet";

import {
  ARB_SEPOLIA_CAIP2,
  SEPOLIA_CAIP2,
  SEPOLIA_CHAIN_ID,
  ZERO_ADDRESS,
  sepoliaRpcUrl,
  trainSolverApiUrl
} from "./config.js";
import {
  CHAIN as SEPOLIA_RAILGUN_CHAIN,
  MIN_GAS_LIMIT,
  NETWORK as SEPOLIA_RAILGUN_NETWORK,
  TXID_VERSION,
  batchMinGasPrice,
  gasDetailsForTransaction,
  initRailgun,
  railgunEncryptionKey,
  wethAddress
} from "./railgun-common.js";
import { loadWallets } from "./state.js";
import type { BestQuote } from "./quote.js";

const RAILGUN_UNSHIELD_FEE_BPS = 25n;
const UNSHIELD_BUFFER_WEI = 10n;

const WETH_WITHDRAW_ABI = ["function withdraw(uint256)"];

function ceilDiv(num: bigint, den: bigint): bigint {
  return (num + den - 1n) / den;
}

function inverseUnshieldGross(netAmount: bigint, feeBps: bigint): bigint {
  let gross = ceilDiv(netAmount * 10_000n, 10_000n - feeBps);
  while ((gross * (10_000n - feeBps)) / 10_000n < netAmount) {
    gross += 1n;
  }
  return gross + UNSHIELD_BUFFER_WEI;
}

export type LockResult = {
  hashlock: string;
  secret: string;
  trainAddress: string;
  sourceTxHash: string;
  blockNumber?: number;
};

/**
 * Build a Sepolia-side Train.userLock call via the Train SDK, capture its
 * encoded calldata, then wrap it inside a Railgun cross-contract call funded
 * by the 0zk shielded balance. Broadcast by the broadcaster EOA loaded from
 * state/wallets.json.
 */
export async function buildAndBroadcastRailgunLock(
  quote: BestQuote,
  amountWei: bigint
): Promise<LockResult> {
  const wallets = await loadWallets();

  const trainSepolia = await resolveTrainAddress(SEPOLIA_CAIP2);

  const secretBytes = randomBytes(32);
  const secret = "0x" + secretBytes.toString("hex");
  const secretBig = BigInt(secret);
  const hashlock = sha256(toBeHex(secretBig, 32));

  registerEvmSdk();

  const broadcasterWallet = new Wallet(wallets.broadcasterPrivateKey);
  const destEoaAddress = new Wallet(wallets.destPrivateKey).address;

  // SDK 0.2.0-dev.2 introduced pure calldata builders. No signer is invoked,
  // no RPC is hit — buildUserLockTx returns the unsigned { to, data, value }
  // directly, which we then wrap inside a Railgun cross-contract call.
  const trainWallet = new EvmHTLCWalletClient({
    rpcUrl: sepoliaRpcUrl(),
    chainId: SEPOLIA_CHAIN_ID,
    signer: undefined as never
  });

  const userLockParams: UserLockParams = {
    sourceChain: SEPOLIA_CAIP2,
    destinationChain: ARB_SEPOLIA_CAIP2,
    // SDK runs parseUnits(amount, decimals) internally, so this must be the
    // decimal-ether string form, not raw wei. destinationAmount and
    // rewardAmount go in as raw wei since the SDK doesn't reparse them.
    amount: formatEther(amountWei),
    destinationAmount: quote.details.receiveAmount,
    sourceAsset: {
      symbol: "ETH",
      contract: ZERO_ADDRESS,
      decimals: 18
    } as never,
    destinationAsset: {
      symbol: "ETH",
      contract: ZERO_ADDRESS,
      decimals: 18
    } as never,
    srcSolverAddress: quote.details.sourceSolverAddress,
    destSolverAddress: quote.details.destinationSolverAddress,
    atomicContract: trainSepolia,
    sourceAddress: broadcasterWallet.address,
    destinationAddress: destEoaAddress,
    quoteExpiry: quote.details.quoteExpirationTimestampInSeconds,
    rewardToken: quote.details.reward.rewardToken,
    rewardRecipient: quote.details.reward.rewardRecipientAddress,
    rewardAmount: quote.details.reward.amount,
    rewardTimelockDelta: quote.details.reward.rewardTimelockTimeSpanInSeconds,
    timelockDelta: quote.details.timelockTimeSpanInSeconds,
    hashlock,
    nonce: Number(BigInt(secret.slice(0, 18))),
    // Solver's quote-id (32-byte signature from the quote response). The HTLC
    // contract stores this as solverData and the solver filters incoming locks
    // by it — without this, the solver never recognizes the source lock as one
    // of its own quotes and will not create the matching destination lock.
    solverData: quote.details.signature
  };

  const userLockTx = trainWallet.buildUserLockTx(userLockParams);
  if (userLockTx.to.toLowerCase() !== trainSepolia.toLowerCase()) {
    throw new Error(
      `Builder produced unexpected to=${userLockTx.to} (expected ${trainSepolia}).`
    );
  }
  if (userLockTx.value !== amountWei) {
    throw new Error(
      `Builder produced unexpected value=${userLockTx.value} (expected ${amountWei}).`
    );
  }

  const wethAddr = wethAddress();
  const wethIface = new Contract(wethAddr, WETH_WITHDRAW_ABI).interface;
  const withdrawData = wethIface.encodeFunctionData("withdraw", [amountWei]);

  const crossContractCalls = [
    { to: wethAddr, value: 0n, data: withdrawData },
    { to: userLockTx.to, value: userLockTx.value, data: userLockTx.data }
  ];

  const grossUnshield = inverseUnshieldGross(amountWei, RAILGUN_UNSHIELD_FEE_BPS);

  await initRailgun();
  const creationBlockNumbers = { [SEPOLIA_RAILGUN_NETWORK]: wallets.railgunCreationBlock };
  const railgunWallet = await createRailgunWallet(
    railgunEncryptionKey(wallets.railgunPassword),
    wallets.railgunMnemonic,
    creationBlockNumbers
  );
  await refreshBalances(SEPOLIA_RAILGUN_CHAIN, [railgunWallet.id]);

  const wallet = fullWalletForID(railgunWallet.id);
  const spendable = await balanceForERC20Token(
    TXID_VERSION,
    wallet,
    SEPOLIA_RAILGUN_NETWORK,
    wethAddr,
    true
  );
  if (spendable < grossUnshield) {
    throw new Error(
      `Spendable shielded WETH ${spendable} < required ${grossUnshield}. ` +
        `Run the orchestrator again so the bootstrap shielding step can top up.`
    );
  }

  const unshield = [{ tokenAddress: wethAddr, amount: grossUnshield }];
  const reshield = [
    { tokenAddress: wethAddr, recipientAddress: railgunWallet.railgunAddress }
  ];

  const provider = new JsonRpcProvider(sepoliaRpcUrl(), SEPOLIA_CHAIN_ID);
  const encryptionKey = railgunEncryptionKey(wallets.railgunPassword);

  const originalGasDetails = await gasDetailsForTransaction(provider, MIN_GAS_LIMIT, true);
  const gasEstimateResp = await gasEstimateForUnprovenCrossContractCalls(
    TXID_VERSION,
    SEPOLIA_RAILGUN_NETWORK,
    railgunWallet.id,
    encryptionKey,
    unshield,
    [],
    reshield,
    [],
    crossContractCalls,
    originalGasDetails,
    undefined,
    true,
    MIN_GAS_LIMIT
  );
  const gasDetails = await gasDetailsForTransaction(provider, gasEstimateResp.gasEstimate, true);
  const overallMin = batchMinGasPrice(gasDetails);

  await generateCrossContractCallsProof(
    TXID_VERSION,
    SEPOLIA_RAILGUN_NETWORK,
    railgunWallet.id,
    encryptionKey,
    unshield,
    [],
    reshield,
    [],
    crossContractCalls,
    undefined,
    true,
    overallMin,
    MIN_GAS_LIMIT,
    (p) => process.stderr.write(`\rPROOF ${Math.round(p)}%   `)
  );
  process.stderr.write("\n");

  const populated = await populateProvedCrossContractCalls(
    TXID_VERSION,
    SEPOLIA_RAILGUN_NETWORK,
    railgunWallet.id,
    unshield,
    [],
    reshield,
    [],
    crossContractCalls,
    undefined,
    true,
    overallMin,
    gasDetails
  );

  const signer = broadcasterWallet.connect(provider);
  const sentTx = await signer.sendTransaction(populated.transaction);
  const receipt = await sentTx.wait();

  return {
    hashlock,
    secret,
    trainAddress: trainSepolia,
    sourceTxHash: sentTx.hash,
    blockNumber: receipt?.blockNumber
  };
}

async function resolveTrainAddress(caip2: string): Promise<string> {
  const { TrainApiClient } = await import("@train-protocol/sdk");
  const client = new TrainApiClient({ baseUrl: trainSolverApiUrl() });
  const networks = await client.getNetworks();
  const network = networks.find((n) => n.caip2Id === caip2);
  if (!network) {
    throw new Error(`Train solver API did not return network ${caip2}`);
  }
  if (!network.trainContract) {
    throw new Error(`Network ${caip2} has no trainContract on the solver API`);
  }
  return network.trainContract;
}
