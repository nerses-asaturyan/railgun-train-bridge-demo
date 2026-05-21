import { access, mkdir, readFile, writeFile } from "node:fs/promises";

import {
  calculateGasPrice,
  EVMGasType,
  getEVMGasTypeForTransaction,
  NETWORK_CONFIG,
  NetworkName,
  TXIDVersion,
  type FallbackProviderJsonConfig,
  type TransactionGasDetails
} from "@railgun-community/shared-models";
import {
  ArtifactStore,
  getEngine,
  getShieldPrivateKeySignatureMessage,
  loadProvider,
  setLoggers,
  startRailgunEngine,
  stopRailgunEngine
} from "@railgun-community/wallet";
import { JsonRpcProvider, Wallet, keccak256, toUtf8Bytes } from "ethers";
import memdown from "memdown";
import { groth16 } from "snarkjs";

import { SEPOLIA } from "./networks.js";
import { RAILGUN_ARTIFACTS_DIR } from "./state.js";

export const NETWORK = NetworkName.EthereumSepolia;
export const TXID_VERSION = TXIDVersion.V2_PoseidonMerkle;
export const CHAIN = NETWORK_CONFIG[NETWORK].chain;
export const SEPOLIA_WETH = NETWORK_CONFIG[NETWORK].baseToken.wrappedAddress;

export const ERC20_ABI = [
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) external returns (bool)",
  "function balanceOf(address owner) view returns (uint256)"
];

export const WETH_ABI = [
  ...ERC20_ABI,
  "function deposit() payable",
  "function withdraw(uint256)"
];

export const MIN_GAS_LIMIT = 3_200_000n;

let engineStarted = false;

export function wethAddress(): string {
  return SEPOLIA_WETH;
}

export function sepoliaProvider(): JsonRpcProvider {
  return new JsonRpcProvider(SEPOLIA.rpc, CHAIN.id);
}

export function railgunEncryptionKey(password: string): string {
  const hex = keccak256(toUtf8Bytes(password));
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

function artifactStore(): ArtifactStore {
  const exists = async (filePath: string) => {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  };

  return new ArtifactStore(
    readFile,
    async (dir, filePath, item) => {
      await mkdir(dir, { recursive: true });
      await writeFile(filePath, item);
    },
    exists
  );
}

export async function initRailgun(): Promise<void> {
  if (engineStarted) return;

  // Ensure artifact cache dir exists under state/.
  await mkdir(RAILGUN_ARTIFACTS_DIR, { recursive: true });

  setLoggers(
    (message: string) => {
      if (process.env.RAILGUN_DEBUG === "1") console.log(`[railgun] ${message}`);
    },
    (error: Error | string) => console.error("[railgun]", error)
  );

  await startRailgunEngine(
    "rgtrainskill",
    memdown() as never,
    process.env.RAILGUN_DEBUG === "1",
    artifactStore(),
    false,
    false,
    [...["https://ppoi.fdi.network"]],
    undefined,
    process.env.RAILGUN_DEBUG === "1"
  );

  getEngine().prover.setSnarkJSGroth16(groth16 as never);

  const fallbackProviderConfig: FallbackProviderJsonConfig = {
    chainId: CHAIN.id,
    providers: [
      {
        provider: SEPOLIA.rpc,
        priority: 1,
        weight: 2
      }
    ]
  };

  await loadProvider(fallbackProviderConfig, NETWORK, 15_000);
  engineStarted = true;
}

export async function shutdownRailgun(): Promise<void> {
  if (!engineStarted) return;
  await stopRailgunEngine();
  engineStarted = false;
}

export async function gasDetailsForTransaction(
  provider: JsonRpcProvider,
  gasEstimate: bigint,
  sendWithPublicWallet = true
): Promise<TransactionGasDetails> {
  const feeData = await provider.getFeeData();
  const evmGasType = getEVMGasTypeForTransaction(NETWORK, sendWithPublicWallet);

  if (evmGasType === EVMGasType.Type2 || evmGasType === EVMGasType.Type4) {
    return {
      evmGasType,
      gasEstimate,
      maxFeePerGas: feeData.maxFeePerGas ?? feeData.gasPrice ?? 1n,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 1n
    };
  }

  return {
    evmGasType,
    gasEstimate,
    gasPrice: feeData.gasPrice ?? feeData.maxFeePerGas ?? 1n
  };
}

export function batchMinGasPrice(gasDetails: TransactionGasDetails): bigint {
  return calculateGasPrice(gasDetails);
}

export async function shieldPrivateKey(wallet: Wallet): Promise<string> {
  const signature = await wallet.signMessage(getShieldPrivateKeySignatureMessage());
  return keccak256(signature);
}
