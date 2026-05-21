import { randomBytes as cryptoRandomBytes } from "node:crypto";

import {
  balanceForERC20Token,
  createRailgunWallet,
  fullWalletForID,
  gasEstimateForShieldBaseToken,
  populateShieldBaseToken,
  refreshBalances
} from "@railgun-community/wallet";
import { JsonRpcProvider, Mnemonic, Wallet, randomBytes as ethersRandomBytes } from "ethers";

import { ARB_SEPOLIA, SEPOLIA } from "./networks.js";
import {
  CHAIN as SEPOLIA_RAILGUN_CHAIN,
  NETWORK as SEPOLIA_RAILGUN_NETWORK,
  TXID_VERSION,
  gasDetailsForTransaction,
  initRailgun,
  railgunEncryptionKey,
  shieldPrivateKey,
  wethAddress
} from "./railgun-common.js";
import {
  hasShield,
  hasWallets,
  loadShield,
  loadWallets,
  saveShield,
  saveWallets,
  type Wallets
} from "./state.js";

// Source-side funding heuristics. Cover: shield amount + shield-tx gas + heavy
// Railgun cross-contract call gas. Sepolia is cheap; we leave a generous margin
// so the broadcaster's balance can't decay below threshold between re-invokes.
const SHIELD_BUFFER_NUM = 11n;
const SHIELD_BUFFER_DEN = 10n;
const SOURCE_GAS_BUDGET_WEI = 10_000_000_000_000_000n; // 0.01 ETH
// Liquid ETH the broadcaster needs when the 0zk wallet is already funded:
// covers only the Railgun cross-contract lock tx gas, not a shield.
const LOCK_ONLY_GAS_BUDGET_WEI = 5_000_000_000_000_000n; // 0.005 ETH
const DEST_GAS_BUDGET_WEI = 1_000_000_000_000_000n; // 0.001 ETH
const BALANCE_SCAN_TIMEOUT_MS = 5 * 60 * 1000;
const BALANCE_SCAN_POLL_MS = 6_000;

// Mirrors lock-railgun.ts constants. Used to compute the realistic minimum
// spendable shielded balance needed to do the lock — i.e. enough to cover the
// 25 bps Railgun unshield fee on the bridge amount.
const RAILGUN_UNSHIELD_FEE_BPS = 25n;
const UNSHIELD_BUFFER_WEI = 10n;

function ceilDiv(num: bigint, den: bigint): bigint {
  return (num + den - 1n) / den;
}

export function shieldAmountFor(bridgeAmountWei: bigint): bigint {
  return (bridgeAmountWei * SHIELD_BUFFER_NUM) / SHIELD_BUFFER_DEN;
}

/**
 * Minimum spendable WETH that must already be in the 0zk wallet for the lock
 * tx to succeed. Equals the gross-unshield amount that nets the bridge amount
 * after the 25 bps Railgun fee, plus a tiny dust buffer. Always smaller than
 * shieldAmountFor() — that one over-shields to absorb the inbound shield fee.
 */
export function minSpendableShieldedFor(bridgeAmountWei: bigint): bigint {
  let gross = ceilDiv(bridgeAmountWei * 10_000n, 10_000n - RAILGUN_UNSHIELD_FEE_BPS);
  while ((gross * (10_000n - RAILGUN_UNSHIELD_FEE_BPS)) / 10_000n < bridgeAmountWei) {
    gross += 1n;
  }
  return gross + UNSHIELD_BUFFER_WEI;
}

export function sourceFundingFor(bridgeAmountWei: bigint): bigint {
  return shieldAmountFor(bridgeAmountWei) + SOURCE_GAS_BUDGET_WEI;
}

export function lockOnlyFundingFor(): bigint {
  return LOCK_ONLY_GAS_BUDGET_WEI;
}

export function destFundingFor(): bigint {
  return DEST_GAS_BUDGET_WEI;
}

function generateMnemonic(): string {
  return Mnemonic.fromEntropy(ethersRandomBytes(16)).phrase.trim();
}

function generatePrivateKey(): `0x${string}` {
  return ("0x" + cryptoRandomBytes(32).toString("hex")) as `0x${string}`;
}

function generatePassword(): string {
  return cryptoRandomBytes(32).toString("hex");
}

/**
 * Generate fresh broadcaster + dest EOAs and a Railgun mnemonic, persist them
 * to state/wallets.json, then derive the Railgun 0zk address by calling
 * createRailgunWallet (which is idempotent for the same mnemonic+key).
 *
 * Returns the persisted state.
 */
export async function initFreshWallets(): Promise<Wallets> {
  if (hasWallets()) {
    return loadWallets();
  }

  // Pick the current Sepolia block as the wallet creation block. This bounds
  // the merkletree re-scan to a tiny window on every subsequent re-invoke.
  const provider = new JsonRpcProvider(SEPOLIA.rpc, SEPOLIA.chainId);
  const railgunCreationBlock = await provider.getBlockNumber();

  const broadcasterPrivateKey = generatePrivateKey();
  const destPrivateKey = generatePrivateKey();
  let railgunMnemonic = generateMnemonic();
  // Belt-and-braces: regenerate if either EOA collides with the dest (vanishingly
  // unlikely but cheap to check).
  if (
    new Wallet(broadcasterPrivateKey).address.toLowerCase() ===
    new Wallet(destPrivateKey).address.toLowerCase()
  ) {
    throw new Error("RNG collision on fresh EOAs (cosmic ray?). Re-run init.");
  }

  const railgunPassword = generatePassword();
  const encryptionKey = railgunEncryptionKey(railgunPassword);

  await initRailgun();
  const railgunWallet = await createRailgunWallet(
    encryptionKey,
    railgunMnemonic,
    { [SEPOLIA_RAILGUN_NETWORK]: railgunCreationBlock }
  );

  const wallets: Wallets = {
    version: 1,
    createdAt: new Date().toISOString(),
    broadcasterPrivateKey,
    destPrivateKey,
    railgunMnemonic,
    railgunPassword,
    railgunWalletId: railgunWallet.id,
    railgunZkAddress: railgunWallet.railgunAddress,
    railgunCreationBlock
  };

  await saveWallets(wallets);
  return wallets;
}

export type SourceFundingStatus =
  | { kind: "ok"; balanceWei: bigint }
  | { kind: "short"; balanceWei: bigint; requiredWei: bigint; shortfallWei: bigint };

export async function checkSourceFunding(
  bridgeAmountWei: bigint,
  wallets: Wallets,
  alreadyShielded: boolean
): Promise<SourceFundingStatus> {
  const required = alreadyShielded
    ? lockOnlyFundingFor()
    : sourceFundingFor(bridgeAmountWei);
  const provider = new JsonRpcProvider(SEPOLIA.rpc, SEPOLIA.chainId);
  const balance = await provider.getBalance(new Wallet(wallets.broadcasterPrivateKey).address);
  if (balance >= required) {
    return { kind: "ok", balanceWei: balance };
  }
  return {
    kind: "short",
    balanceWei: balance,
    requiredWei: required,
    shortfallWei: required - balance
  };
}

/**
 * Boot the Railgun engine, hydrate the wallet, refresh balances, and return the
 * current spendable WETH balance in the 0zk wallet on Sepolia. Used to decide
 * whether the broadcaster needs full shield-budget liquid ETH, or only enough
 * for the lock tx.
 */
export async function probeShieldedBalance(wallets: Wallets): Promise<bigint> {
  await initRailgun();
  await createRailgunWallet(
    railgunEncryptionKey(wallets.railgunPassword),
    wallets.railgunMnemonic,
    { [SEPOLIA_RAILGUN_NETWORK]: wallets.railgunCreationBlock }
  );
  await refreshBalances(SEPOLIA_RAILGUN_CHAIN, [wallets.railgunWalletId]);
  const railgunWallet = fullWalletForID(wallets.railgunWalletId);
  return balanceForERC20Token(
    TXID_VERSION,
    railgunWallet,
    SEPOLIA_RAILGUN_NETWORK,
    wethAddress(),
    true
  );
}

export type DestFundingStatus =
  | { kind: "ok"; balanceWei: bigint }
  | { kind: "short"; balanceWei: bigint; requiredWei: bigint; shortfallWei: bigint };

export async function checkDestFunding(wallets: Wallets): Promise<DestFundingStatus> {
  const required = destFundingFor();
  const provider = new JsonRpcProvider(ARB_SEPOLIA.rpc, ARB_SEPOLIA.chainId);
  const balance = await provider.getBalance(new Wallet(wallets.destPrivateKey).address);
  if (balance >= required) {
    return { kind: "ok", balanceWei: balance };
  }
  return {
    kind: "short",
    balanceWei: balance,
    requiredWei: required,
    shortfallWei: required - balance
  };
}

export type ShieldingStatus =
  | { kind: "already-shielded"; shieldedWei: bigint }
  | { kind: "shielded-now"; txHash: string; shieldedWei: bigint; block: number };

/**
 * If shielded balance already covers the bridge requirement, no-op. Otherwise
 * sign+send a base-token shield from the broadcaster EOA into the 0zk address,
 * wait for it to confirm, then poll until the Railgun engine sees the new UTXO.
 */
export async function ensureShielded(
  bridgeAmountWei: bigint,
  wallets: Wallets,
  onProgress?: (msg: string) => void
): Promise<ShieldingStatus> {
  // Two thresholds:
  // - minSpendable: what we need *spendable* to do the lock (covers 25 bps unshield fee).
  // - shieldAmount: what we'd *gross-shield* on a fresh shield (over-shields to absorb the 25 bps shield fee).
  const minSpendable = minSpendableShieldedFor(bridgeAmountWei);
  const minShield = shieldAmountFor(bridgeAmountWei);

  await initRailgun();
  await createRailgunWallet(
    railgunEncryptionKey(wallets.railgunPassword),
    wallets.railgunMnemonic,
    { [SEPOLIA_RAILGUN_NETWORK]: wallets.railgunCreationBlock }
  );
  await refreshBalances(SEPOLIA_RAILGUN_CHAIN, [wallets.railgunWalletId]);

  const railgunWallet = fullWalletForID(wallets.railgunWalletId);
  const existing = await balanceForERC20Token(
    TXID_VERSION,
    railgunWallet,
    SEPOLIA_RAILGUN_NETWORK,
    wethAddress(),
    true
  );
  if (existing >= minSpendable) {
    return { kind: "already-shielded", shieldedWei: existing };
  }

  const provider = new JsonRpcProvider(SEPOLIA.rpc, SEPOLIA.chainId);
  const broadcasterWallet = new Wallet(wallets.broadcasterPrivateKey, provider);
  const spk = await shieldPrivateKey(broadcasterWallet);

  const wrappedERC20Amount = { tokenAddress: wethAddress(), amount: minShield };

  onProgress?.("estimating shield gas");
  const gasEstimateResp = await gasEstimateForShieldBaseToken(
    TXID_VERSION,
    SEPOLIA_RAILGUN_NETWORK,
    wallets.railgunZkAddress,
    spk,
    wrappedERC20Amount,
    broadcasterWallet.address
  );

  const gasDetails = await gasDetailsForTransaction(
    provider,
    gasEstimateResp.gasEstimate,
    true
  );

  onProgress?.("populating shield tx");
  const populated = await populateShieldBaseToken(
    TXID_VERSION,
    SEPOLIA_RAILGUN_NETWORK,
    wallets.railgunZkAddress,
    spk,
    wrappedERC20Amount,
    gasDetails
  );

  onProgress?.("broadcasting shield tx");
  const sentTx = await broadcasterWallet.sendTransaction(populated.transaction);
  const receipt = await sentTx.wait();
  if (!receipt) {
    throw new Error(`Shield tx ${sentTx.hash} did not produce a receipt.`);
  }

  onProgress?.("waiting for Railgun scan to surface UTXO");
  await waitForShieldedBalance(railgunWallet, minSpendable);

  const record = {
    txHash: sentTx.hash as `0x${string}`,
    shieldedWei: minShield.toString(),
    block: receipt.blockNumber
  };
  await saveShield(record);

  return { kind: "shielded-now", txHash: record.txHash, shieldedWei: minShield, block: record.block };
}

async function waitForShieldedBalance(
  railgunWallet: ReturnType<typeof fullWalletForID>,
  required: bigint
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < BALANCE_SCAN_TIMEOUT_MS) {
    await refreshBalances(SEPOLIA_RAILGUN_CHAIN, [railgunWallet.id]);
    const spendable = await balanceForERC20Token(
      TXID_VERSION,
      railgunWallet,
      SEPOLIA_RAILGUN_NETWORK,
      wethAddress(),
      true
    );
    if (spendable >= required) return;
    await new Promise((r) => setTimeout(r, BALANCE_SCAN_POLL_MS));
  }
  throw new Error(
    `Shield tx confirmed but Railgun balance scan did not surface ${required} WETH within ${BALANCE_SCAN_TIMEOUT_MS / 1000}s. ` +
      `POI registration may still be pending; re-run the orchestrator in a minute.`
  );
}

export async function alreadyShieldedAmountWei(): Promise<bigint> {
  if (!hasShield()) return 0n;
  const r = await loadShield();
  return r ? BigInt(r.shieldedWei) : 0n;
}
