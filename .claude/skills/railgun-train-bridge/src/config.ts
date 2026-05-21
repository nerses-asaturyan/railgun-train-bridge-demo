import { Wallet } from "ethers";

import { ARB_SEPOLIA, SEPOLIA, TRAIN_SOLVER_API } from "./networks.js";
import { loadWallets, type Wallets } from "./state.js";

export {
  SEPOLIA_CAIP2,
  ARB_SEPOLIA_CAIP2,
  SEPOLIA_CHAIN_ID,
  ARB_SEPOLIA_CHAIN_ID,
  ZERO_ADDRESS
} from "./networks.js";

let cached: Wallets | null = null;

async function wallets(): Promise<Wallets> {
  if (!cached) cached = await loadWallets();
  return cached;
}

export const sepoliaRpcUrl = () => SEPOLIA.rpc;
export const arbSepoliaRpcUrl = () => ARB_SEPOLIA.rpc;
export const trainSolverApiUrl = () => TRAIN_SOLVER_API;

export async function broadcasterKey(): Promise<string> {
  return (await wallets()).broadcasterPrivateKey;
}

export async function destKey(): Promise<string> {
  return (await wallets()).destPrivateKey;
}

export async function broadcasterAddress(): Promise<string> {
  return new Wallet((await wallets()).broadcasterPrivateKey).address;
}

export async function destAddress(): Promise<string> {
  return new Wallet((await wallets()).destPrivateKey).address;
}
