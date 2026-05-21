import {
  EvmHTLCPublicClient,
  EvmHTLCWalletClient,
  registerEvmSdk
} from "@train-protocol/evm";
import type { EvmSigner } from "@train-protocol/evm";
import type { SolverLockDetails } from "@train-protocol/sdk";
import { JsonRpcProvider, Wallet } from "ethers";

import {
  ARB_SEPOLIA_CAIP2,
  ARB_SEPOLIA_CHAIN_ID,
  ZERO_ADDRESS,
  arbSepoliaRpcUrl,
  destAddress,
  destKey,
  trainSolverApiUrl
} from "./config.js";

const POLL_INTERVAL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export type PollAndRedeemArgs = {
  hashlock: string;
  secret: string;
  trainContract?: string;
  amountForReadDecimals?: number;
  pollTimeoutMs?: number;
};

export type RedeemResult = {
  solverLock: SolverLockDetails;
  redeemTxHash: string;
};

class EthersEvmSigner implements EvmSigner {
  readonly address: string;
  private wallet: Wallet;

  constructor(privateKey: string, rpcUrl: string, chainId: number) {
    const provider = new JsonRpcProvider(rpcUrl, chainId);
    this.wallet = new Wallet(privateKey, provider);
    this.address = this.wallet.address;
  }

  async sendTransaction(tx: {
    to: string;
    data: string;
    value?: bigint;
    chainId?: number;
  }): Promise<string> {
    const sent = await this.wallet.sendTransaction({
      to: tx.to,
      data: tx.data,
      value: tx.value ?? 0n
    });
    await sent.wait();
    return sent.hash;
  }
}

export async function pollAndRedeem(args: PollAndRedeemArgs): Promise<RedeemResult> {
  registerEvmSdk();

  const rpcUrl = arbSepoliaRpcUrl();
  const publicClient = new EvmHTLCPublicClient({
    rpcUrl,
    chainId: ARB_SEPOLIA_CHAIN_ID
  });

  const trainArbAddress =
    args.trainContract ?? (await resolveTrainAddress(ARB_SEPOLIA_CAIP2));

  const start = Date.now();
  const timeout = args.pollTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  let solverLock: SolverLockDetails | null = null;

  while (Date.now() - start < timeout) {
    solverLock = await publicClient.getSolverLockDetails(
      {
        id: args.hashlock,
        chainId: String(ARB_SEPOLIA_CHAIN_ID),
        contractAddress: trainArbAddress,
        decimals: args.amountForReadDecimals ?? 18
      },
      rpcUrl
    );
    if (solverLock) {
      process.stderr.write(
        `\nSolver lock found on Arb Sepolia at index ${solverLock.index}\n`
      );
      break;
    }
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    process.stderr.write(`\rPolling Arb Sepolia for solver lock (${elapsed}s)`);
    await sleep(POLL_INTERVAL_MS);
  }

  if (!solverLock) {
    throw new Error(
      `No solver lock found on Arb Sepolia within ${(timeout / 1000).toFixed(0)}s. ` +
        `Source userLock may need a manual refund after timelockDelta expires.`
    );
  }

  const destPk = await destKey();
  const expectedDest = await destAddress();
  const signer = new EthersEvmSigner(destPk, rpcUrl, ARB_SEPOLIA_CHAIN_ID);
  if (signer.address.toLowerCase() !== expectedDest.toLowerCase()) {
    throw new Error("Internal: dest signer address mismatch");
  }

  const walletClient = new EvmHTLCWalletClient({
    rpcUrl,
    chainId: ARB_SEPOLIA_CHAIN_ID,
    signer
  });

  const redeemTxHash = await walletClient.redeemSolver({
    chainId: String(ARB_SEPOLIA_CHAIN_ID),
    contractAddress: trainArbAddress,
    id: args.hashlock,
    secret: args.secret,
    sourceAsset: { symbol: "ETH", contract: ZERO_ADDRESS, decimals: 18 } as never,
    destinationAddress: signer.address,
    destinationAsset: { symbol: "ETH", contract: ZERO_ADDRESS, decimals: 18 } as never,
    index: solverLock.index
  });

  return { solverLock, redeemTxHash };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveTrainAddress(caip2: string): Promise<string> {
  const { TrainApiClient } = await import("@train-protocol/sdk");
  const client = new TrainApiClient({ baseUrl: trainSolverApiUrl() });
  const networks = await client.getNetworks();
  const network = networks.find((n) => n.caip2Id === caip2);
  if (!network || !network.trainContract) {
    throw new Error(`Solver API didn't return a trainContract for ${caip2}`);
  }
  return network.trainContract;
}
