---
name: railgun-train-bridge
description: Run, drive, and demo the Railgun + Train Protocol private cross-chain bridge from Sepolia to Arbitrum Sepolia. Use when asked to bridge ETH via Railgun + Train, run the private bridge demo, start a private cross-chain swap, generate the three demo wallets, or show how a Railgun shielded balance funds a Train HTLC lock. Self-contained skill — wallets and state live inside the skill folder, no .env file needed.
---

# Railgun + Train Private Bridge Skill

Self-contained CLI orchestrator that demos a privacy-preserving cross-chain bridge: Sepolia (ETH → Railgun shield → Train HTLC lock) → Arbitrum Sepolia (solver matches → secret revealed → redeem). All paths below are relative to this skill folder (`.claude/skills/railgun-train-bridge/`).

The orchestrator at [src/index.ts](src/index.ts) **is** the driver — each invocation reads state, advances one step, emits structured JSON events on stdout, and exits cleanly when it needs the operator to fund an address or confirm. The agent's job is to parse those events, narrate milestones, prompt the operator for funding, then re-run the **exact same command** on "continue".

Invoke when the operator says any of:

- `/railgun-train-bridge`
- "bridge X ETH from Sepolia to Arb Sepolia via Railgun"
- "do a private bridge demo"
- "show how Railgun + Train work together"

## What the demo proves

1. The Sepolia-side `Train.userLock` is funded out of a Railgun shielded balance. Etherscan shows the value comes out of the Railgun Relay Adapt contract — there is **no public wallet that "deposits" into the lock**.
2. The Sepolia tx is signed by a fresh broadcaster EOA with no other on-chain history. Its `tx.from` is visible but cannot be linked to the operator's primary identity.
3. The Arbitrum-Sepolia redeem (which reveals the HTLC secret) is signed by a third, separately-generated EOA. Same address also receives the funds.

Three fresh keys, three roles, zero correlation surface.

## Prerequisites

- **Node.js >= 20** (uses native `fetch`, ESM-only).
- **Testnet ETH**: ~0.011 Sepolia ETH + ~0.001 Arb Sepolia ETH, sent to two addresses the orchestrator will print on first run. Faucets: [sepoliafaucet.com](https://sepoliafaucet.com), [Alchemy Arb Sepolia](https://www.alchemy.com/faucets/arbitrum-sepolia).

No system packages, no Docker, no env vars. Everything is pure Node.

## Setup (one-time per machine)

```powershell
npm install
```

Installs the Railgun engine, Train SDK, ethers, tsx, etc. Takes ~5 min the first time (large native deps). If `node_modules/` is missing when the agent invokes the skill, run this first.

## Run (agent path) — what an agent should do

### Step 1 — pre-flight smoke (no funds spent)

Before kicking off the demo, run the smoke script. It probes the two external dependencies that have failed in production (POI aggregator and Train solver API), type-checks the source, and runs the orchestrator far enough to generate fresh wallets — without spending any testnet ETH.

```powershell
npm run smoke
```

Expected output, all green:

```
railgun-train-bridge :: pre-flight smoke

environment
  Node >= 20 ... ✓  (v...)

external dependencies
  POI aggregator responds ... ✓  (idx N)
  Train solver API returns a quote ... ✓  (Plorex: NNN wei out)

source
  tsc --noEmit ... ✓

orchestrator
  npm run demo -> state.initialized ... ✓  (broadcaster 0x...)

All checks passed.
```

If anything fails, see Troubleshooting below before proceeding.

### Step 2 — extract the bridge intent

Default amount is **0.0001 ETH** (`100000000000000` wei). If the operator names a different amount in ETH (e.g. "bridge 0.00001 ETH"), convert to wei before passing:

```powershell
npm run demo -- --amount 10000000000000
```

### Step 3 — run the orchestrator, narrate one stage at a time

```powershell
npm run demo -- --amount 100000000000000
```

The orchestrator is a **re-entrant state machine**. Each invocation reads `state/`, advances one step, and emits one or more structured JSON lines on stdout. When it hits a "needs funding" or "needs operator decision" state, it exits cleanly (exit 0). The agent narrates the milestone, prompts the operator to fund the named address, waits for them to say "continue", then re-runs the exact same command. State persistence makes this safe.

Parse each stdout JSON line by its `stage` field:

| Stage | Fields | What to say to the operator |
|---|---|---|
| `state.uninitialized` | `statePath` | "First run — generating three fresh wallets locally." |
| `state.initialized` | `broadcasterAddress`, `destAddress`, `railgunZkAddress`, `recommendedSourceFundingWei`, `recommendedDestFundingWei`, `statePath` | "Done. Fund the **broadcaster** on Sepolia with at least N ETH and the **dest** on Arbitrum Sepolia with at least M ETH. Secrets live at `statePath` — I won't echo them here. Tell me when funded." Then **stop and wait**. |
| `state.probing_shield` | (none) | "Checking the 0zk wallet for existing shielded balance..." |
| `state.shield_probe` | `shieldedWei`, `minSpendableWei`, `alreadyShielded` | If `alreadyShielded: true`, "Existing shielded balance is enough — skipping re-shield." Otherwise nothing to narrate yet. |
| `state.awaiting_source_funding` | `address`, `currentWei`, `requiredWei`, `shortfallWei`, `chain` | "Broadcaster needs more Sepolia ETH (current X, need Y, short Z). Send to `address`, then say continue." **Stop and wait.** |
| `state.shielding` | `targetShieldedWei` | "Shielding into the 0zk wallet now — one Sepolia tx + a balance scan." |
| `state.shielded` | `reused` or `{shieldTxHash, shieldedWei, block}` | If `reused: true`, "Already shielded enough — reusing." Otherwise quote `shieldTxHash` (Sepolia Etherscan link) and confirm the scan landed. |
| `state.awaiting_dest_funding` | `address`, `currentWei`, `requiredWei` | "Dest EOA needs ~0.001 ETH on Arb Sepolia. Send to `address`, then continue." **Stop and wait.** |
| `state.ready` | `amountWei`, `broadcasterAddress`, `destAddress` | "All funded, kicking off the swap." |
| `quote.requesting` | `amountWei` | "Asking the Train solver network for a quote..." |
| `quote.received` | `solverName`, `receiveAmount`, `quoteExpiry`, ... | "Got a quote from `solverName` — expires in ~Ns." |
| `source.locking` | `secondsToProof` | "Generating the Railgun ZK proof — this is the privacy layer kicking in. 30–60s." |
| `source.locked` | `sourceTxHash`, `trainAddress`, `hashlock`, `blockNumber` | Quote `sourceTxHash`. Tell the audience to open it on Sepolia Etherscan: `tx.from` is the anonymous broadcaster, `to` is the Railgun Relay Adapt, and there is no public ERC20 transfer in this tx — funds came out of Railgun's shielded merkletree. **This is the headline privacy moment.** |
| `dest.polling` | `hashlock` | "Now we wait for the solver to match the lock on Arb Sepolia (~30s – few min)." |
| `dest.redeemed` | `solverLockIndex`, `redeemTxHash`, `recipient` | Quote `redeemTxHash`. "Secret revealed on Arb Sepolia by a third, separately-funded key. The solver will now redeem the Sepolia side using the on-chain secret." |
| `done` | `sourceTx`, `destTx`, `hashlock` | Summary: source tx + dest tx, recipient = anonymous DEST EOA. |
| `error` | `message` | Surface the message + recovery hint from Troubleshooting. |

### Step 4 — re-invoke loop

Any `state.awaiting_*` event ends a turn. **Do not** re-run the orchestrator on the agent's own initiative. Wait for the operator to fund and say "continue", "ready", "go", etc. — then re-run the exact same command.

## Run (human path)

A human can run the same orchestrator directly:

```powershell
npm run demo -- --amount 100000000000000
```

But without an agent to parse the JSON events, narrate, and tell them which address to fund and when, the raw output is a wall of structured logs. The agent path is the intended interface.

## Reset

Brand new wallets (e.g. demoing to a different audience):

```powershell
npm run reset
```

This wipes `state/`. Next `npm run demo` starts from `state.uninitialized`. Warning: wipes the 0zk mnemonic — any shielded balance held by the previous wallet becomes unrecoverable.

## Portability

Everything the demo needs lives inside this skill folder. To use on a fresh machine: drop the folder into `~/.claude/skills/` (or this project's `.claude/skills/`), make sure Node.js >= 20 is installed, then invoke from inside Claude Code.

Secrets are generated locally on first run and persisted to `state/wallets.json` inside the skill folder (gitignored, file mode 0o600 on POSIX). **Never echo the mnemonic or private keys to the operator** — if they ask, point them at the file path.

## Gotchas

Battle scars from making this skill actually work end-to-end. None of these are obvious from the SDK docs.

- **Railgun POI aggregator URL** is hardcoded in [src/networks.ts](src/networks.ts) and [src/railgun-common.ts](src/railgun-common.ts). The URL documented in the official Railgun developer guide (`ppoi-agg.horsewithsixlegs.xyz`) is currently NXDOMAIN. This skill uses `ppoi.fdi.network`, which is alive. If that goes down too, ask in the Railgun builders group for a current public aggregator; no SDK default exists.
- **Train solver API host matters.** The "obvious" host `train-solver-station.lb.layerswap.io` serves a **Cloudflare Origin Certificate** directly from an Azure LB (DNS doesn't proxy through Cloudflare). Public clients can't verify it → `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. The skill uses `train-solver-station.dev.lb.layerswap.cloud` (.cloud, public cert). Don't switch to the .io host even if a doc page suggests it.
- **`userLockParams.amount` is a decimal-ether string, not wei.** The Train SDK's `buildUserLockTx` internally runs `parseUnits(amount, decimals)`. Passing `"100000000000000"` (the wei value for 0.0001 ETH) produces an on-chain `value` of 10^32 wei — 14 orders of magnitude too large; `eth_call` rejects with "insufficient funds". Use `formatEther(amountWei)` to produce `"0.0001"`. `destinationAmount` and `rewardAmount`, by contrast, are raw wei.
- **`userLockParams.solverData` must be set** to `quote.details.signature` (the 32-byte quote ID returned by the solver). Without it, the on-chain HTLC is created with empty `solverData`, and the solver never recognizes the lock as one of its own quotes → no matching lock on Arb Sepolia → 10-minute timeout. Source funds end up refundable only after the timelock expires (default 2h).
- **Railgun's 25 bps shield fee** means a fresh shield of N wei yields only N*0.9975 spendable in the 0zk wallet. The "already-shielded enough" check uses a fee-aware threshold (`minSpendableShieldedFor` in [src/bootstrap.ts](src/bootstrap.ts) — covers the 25 bps unshield fee on the lock side, ~1.0025x the bridge amount), not the gross shield target. Comparing against the gross would loop forever asking to re-shield.
- **`startRailgunEngine`'s wallet-source string** has hidden constraints: must be **< 16 characters** AND **only `[a-zA-Z0-9]`** (no hyphens). Hidden in [src/railgun-common.ts](src/railgun-common.ts) as `"rgtrainskill"`. Change it and you get cryptic Railgun SDK errors at boot.
- **Source-funding check vs already-shielded.** The orchestrator probes the 0zk balance **before** the funding check. If the wallet already has enough shielded WETH, the broadcaster only needs ~0.005 ETH for the lock tx gas (`LOCK_ONLY_GAS_BUDGET_WEI`), not the full ~0.011 ETH shield-budget. Without this, a re-run after a successful shield asks for nonsense funding.
- **Solver liveness is your demo's biggest single failure mode.** Even with everything wired right, the solver may not pick up the lock within 10 minutes (off-chain matching, MEV considerations, solver downtime). When it doesn't, the only recovery is to refund after `timelockTimeSpanInSeconds` expires (default 7200s = 2h). Don't promise a 100% live demo to an audience without a backup plan.

## Troubleshooting

Symptom → fix. Each of these actually happened during development.

- **`Wallet source must be less than 16 characters`** — `startRailgunEngine`'s first arg too long. Shorten the string in [src/railgun-common.ts](src/railgun-common.ts).
- **`Invalid character for wallet source: -`** — same arg has a hyphen. Strip non-alphanumerics.
- **`getaddrinfo ENOTFOUND ppoi-agg.horsewithsixlegs.xyz`** — old POI URL is dead. The current skill points at `ppoi.fdi.network`. If that's also down, find a live one (ask the Railgun builders group).
- **`UNABLE_TO_VERIFY_LEAF_SIGNATURE` from fetch** — Train solver host is serving an unverifiable cert. Confirm `TRAIN_SOLVER_API` in [src/networks.ts](src/networks.ts) is the `.dev.lb.layerswap.cloud` URL, not `.lb.layerswap.io`.
- **`insufficient funds for gas * price + value: address X have N want 100000000000000000000000000000000`** — that 10^32 `want` is the 0.0001 ETH bridge amount, multiplied by 10^18. Units bug. In [src/lock-railgun.ts](src/lock-railgun.ts), the `userLockParams.amount` field must be `formatEther(amountWei)`, not `amountWei.toString()`.
- **`No solver lock found on Arb Sepolia within 600s`** — solver didn't pick up. Most likely cause: `userLockParams.solverData` wasn't set; verify [src/lock-railgun.ts](src/lock-railgun.ts) passes `solverData: quote.details.signature`. If `solverData` is correct and the solver still didn't match, it's solver-side liveness. The source lock will need a manual refund after the timelock expires (operator handles separately).
- **`Spendable shielded WETH N < required M`** — broadcaster needs more ETH and a re-shield. The state machine will hit `state.awaiting_source_funding` on the next run; ask the operator to top up.
- **`balance scan did not surface ...`** — POI registration may still be pending. Wait ~1 minute and re-run the same command.
- **Quote expires in Ns** — the previous quote went stale during ZK proof gen. The next re-run fetches a fresh quote.

## What NOT to do

- Do not invoke this skill for unrelated questions about Train or Railgun.
- Do not retry on quote-expired errors automatically; the operator may want to pause the demo to explain the privacy story between attempts.
- Do not echo the mnemonic or any private-key material to chat output. They live in `state/wallets.json` only.
- Do not commit `state/` — the `.gitignore` already covers it, but be aware.

## Reference

- Orchestrator source: [src/](src/) (state machine in [src/index.ts](src/index.ts))
- Bootstrap flow (key gen + auto-shield + fee-aware funding): [src/bootstrap.ts](src/bootstrap.ts)
- Sepolia-side lock (the privacy step): [src/lock-railgun.ts](src/lock-railgun.ts)
- Arb Sepolia-side poll + redeem: [src/poll-and-redeem.ts](src/poll-and-redeem.ts)
- Train solver quote: [src/quote.ts](src/quote.ts)
- Hardcoded RPCs + chain config: [src/networks.ts](src/networks.ts)
- Railgun engine helpers: [src/railgun-common.ts](src/railgun-common.ts)
- State persistence: [src/state.ts](src/state.ts)
- Pre-flight smoke driver: [smoke.mjs](smoke.mjs)
- Train SDK (pinned): `@train-protocol/{sdk,evm}@0.2.0-dev.2`, `@train-protocol/auth@0.2.0-dev.1`
- Railgun SDK (pinned): `@railgun-community/wallet@10.8.6`
