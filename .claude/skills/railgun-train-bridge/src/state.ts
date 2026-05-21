import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_DIR = path.resolve(SRC_DIR, "..");
export const STATE_DIR = path.join(SKILL_DIR, "state");
export const WALLETS_PATH = path.join(STATE_DIR, "wallets.json");
export const SHIELD_PATH = path.join(STATE_DIR, "shield.json");
export const RAILGUN_ARTIFACTS_DIR = path.join(STATE_DIR, "railgun-artifacts");

export type Wallets = {
  version: 1;
  createdAt: string;
  broadcasterPrivateKey: `0x${string}`;
  destPrivateKey: `0x${string}`;
  railgunMnemonic: string;
  railgunPassword: string;
  railgunWalletId: string;
  railgunZkAddress: string;
  railgunCreationBlock: number;
};

export type ShieldRecord = {
  txHash: `0x${string}`;
  shieldedWei: string;
  block: number;
};

export function hasWallets(): boolean {
  return existsSync(WALLETS_PATH);
}

export function hasShield(): boolean {
  return existsSync(SHIELD_PATH);
}

export async function loadWallets(): Promise<Wallets> {
  const raw = await readFile(WALLETS_PATH, "utf8");
  const parsed = JSON.parse(raw) as Wallets;
  if (parsed.version !== 1) {
    throw new Error(`Unsupported wallets state version ${parsed.version}`);
  }
  return parsed;
}

export async function saveWallets(w: Wallets): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(WALLETS_PATH, JSON.stringify(w, null, 2), "utf8");
  // Best-effort restrict perms on POSIX. Silently no-op on Windows.
  try {
    await chmod(WALLETS_PATH, 0o600);
  } catch {
    /* windows: ignore */
  }
}

export async function loadShield(): Promise<ShieldRecord | null> {
  if (!hasShield()) return null;
  const raw = await readFile(SHIELD_PATH, "utf8");
  return JSON.parse(raw) as ShieldRecord;
}

export async function saveShield(r: ShieldRecord): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(SHIELD_PATH, JSON.stringify(r, null, 2), "utf8");
}

export async function wipeState(): Promise<void> {
  await rm(STATE_DIR, { recursive: true, force: true });
}
