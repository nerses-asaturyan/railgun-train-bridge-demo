# Railgun + Train Private Bridge

A self-contained Claude Code skill that demos a **privacy-preserving cross-chain bridge**: native ETH from Sepolia to Arbitrum Sepolia, using **Railgun** for the privacy layer and **Train Protocol** for HTLC settlement.

Everything the demo needs lives in [.claude/skills/railgun-train-bridge/](.claude/skills/railgun-train-bridge/). No `.env` file. No external repo. All secrets are generated locally on first run and written to `state/wallets.json` inside the skill folder (mode 0o600 on POSIX, gitignored).

## What the demo proves

1. The Sepolia-side `Train.userLock` is funded out of a Railgun shielded balance. On Etherscan, the value comes out of the Railgun Relay Adapt contract — there is no public wallet that "deposits" into the lock.
2. The Sepolia tx is signed by a fresh broadcaster EOA with no other on-chain history.
3. The Arbitrum-Sepolia redeem (which reveals the HTLC secret) is signed by a third, separately-generated EOA. Same address also receives the funds.

Three fresh keys, three roles, zero correlation surface.

## How to use it

### Recommended: via Claude Code (agent-driven)

1. Drop [.claude/skills/railgun-train-bridge/](.claude/skills/railgun-train-bridge/) into the `.claude/skills/` of any project, or into `~/.claude/skills/` for a global install.
2. Install Node.js >= 20.
3. Open Claude Code in that project.
4. Type one of:
   - `/railgun-train-bridge`
   - `bridge 0.0001 ETH via Railgun + Train`
   - `do a private bridge demo`

The skill auto-loads and the agent takes over: installs deps if missing, generates three fresh wallets, tells you which addresses to fund, runs a pre-flight smoke, then drives the bridge end-to-end — narrating each privacy milestone and stopping cleanly to wait for you when funding is needed.

You don't type any other commands. That's the whole point of a skill.

### Manual: run the orchestrator directly

For inspecting the orchestrator without Claude Code in the loop.

**Prereqs**: Node.js >= 20, testnet ETH (~0.011 Sepolia, ~0.001 Arb Sepolia).

```powershell
cd .claude\skills\railgun-train-bridge
npm install
```

Pre-flight smoke (no funds spent — probes external deps + type-check + generates fresh wallets):

```powershell
npm run smoke
```

Run the demo (default 0.0001 ETH; substitute any wei amount):

```powershell
npm run demo -- --amount 100000000000000
```

The orchestrator emits structured JSON events on stdout — one event per stage. When it needs you to fund an address or confirm something, it exits cleanly (exit 0). Fund the named address, then re-run the **exact same command**; the state machine resumes where it stopped. State is persisted in `state/` between invocations.

Reset (wipe wallets and start over):

```powershell
npm run reset
```

For the full stage → narration table, list of gotchas, and troubleshooting symptoms-to-fixes, see [.claude/skills/railgun-train-bridge/SKILL.md](.claude/skills/railgun-train-bridge/SKILL.md).

## Architecture in one diagram

```
Sepolia                                   Arbitrum Sepolia
─────────                                 ────────────────

broadcaster EOA ──shield──> Railgun 0zk
                            shielded WETH
                                  │
                                  │  (Railgun cross-contract call:
                                  │   unshield → WETH.withdraw → Train.userLock)
                                  ▼
                            Train HTLC
                            (hashlock H)                Train HTLC
                                                       (hashlock H)
                                                            ▲
                                                            │  solver matches
                                                            │  (lock funded by solver)
                                                            │
                                                       dest EOA ──redeem(secret)──>
                                                            │
                            Train HTLC                     dest EOA
                            (hashlock H)                   receives bridged ETH
                                  ▲
                                  │  solver redeems source-side
                                  │  using the on-chain-revealed secret
                                  │
                            solver receives
                            source ETH (+ reward)
```

Three actors on-chain (broadcaster, dest EOA, solver). The Railgun 0zk wallet is an off-chain merkletree position — it never appears as a sender or receiver on Etherscan.

## Repository layout

```
railgun-train-bridge-demo/
├── README.md                                ← you are here
├── .gitignore
└── .claude/
    └── skills/
        └── railgun-train-bridge/            ← the skill (drop-in portable)
            ├── SKILL.md                     ← agent-facing instructions
            ├── smoke.mjs                    ← pre-flight driver
            ├── package.json
            ├── tsconfig.json
            ├── src/                         ← TypeScript orchestrator
            ├── types/
            ├── artifacts-v2.1/              ← Railgun ZK precompiled artifacts
            └── .gitignore                   ← gitignores node_modules/ + state/
```

## License

MIT.
