# TouchGrass

## Make less screen time feel real

TouchGrass is a screen-time commitment vault for people who know the feeling: a day disappears into the phone, then any money sitting in the bank disappears with it.

Instead of trying to shame someone out of a habit, TouchGrass lets them pre-commit a small daily spending allowance. They lock a budget in **mUSDC**. If yesterday’s Android app-use time stayed below their chosen limit, they can claim that day’s mUSDC. If not, it remains locked as savings until the program ends.

**MON is only the gas fee. mUSDC is the budget and the reward.**

> Testnet MVP only. mUSDC and MON on Monad Testnet have no real-world value. TouchGrass is voluntary self-accountability, not a cryptographic proof that a phone owner has not manipulated their device data.

## Why this is different

Most screen-time apps ask you to resist a feed at the exact moment it is designed to be irresistible. TouchGrass moves the decision earlier:

1. Choose a realistic limit and daily amount.
2. Lock the whole budget before the program starts.
3. Earn access to each daily allowance with a completed low-screen-time day.
4. Let a miss become savings, rather than another reason to give up.

The reward is intentionally small and predictable. The point is not gambling on a streak; it is rebuilding the connection between attention, intention, and spending.

## The loop

```text
Mint test mUSDC → approve & lock a 7 / 14 / 28-day budget
       ↓
Android measures aggregate foreground app time (TouchGrass excluded)
       ↓
Next day: wallet signs the aggregate check-in
       ↓
Verifier checks one closed day + one voucher per day
       ↓
Below target → claim daily mUSDC      Above target → mUSDC remains saved
```

Only aggregate seconds, program metadata, and voucher state leave the device. Per-app activity and local analytics stay on the phone.

## Built for Monad Spark

TouchGrass puts Monad in the part that matters: the budget is held and released onchain, and every successful day produces a visible, verifiable claim. Monad’s low-cost testnet transactions make the two-step budget flow practical for a daily habit loop.

| Layer | What it does |
| --- | --- |
| Android / Expo | Requests Android Usage Access, aggregates foreground use, keeps local insights |
| Monad vault | Custodies mUSDC, prevents replayed claims, holds missed days through cooldown |
| Cloudflare Worker + D1 | Verifies wallet-signed reports, prevents duplicate vouchers, signs EIP-712 claims |
| mUSDC faucet | Gives every demo wallet a harmless 1,000 mUSDC test budget |

## Live testnet deployment

- **mUSDC faucet:** [`0x59E6…9Ad1`](https://testnet.monadscan.com/address/0x59E68C80762c7eC8F1172eD893b32947dacf9Ad1) — 6 decimals; `mint()` gives the caller 1,000 mUSDC.
- **AllowanceVault:** [`0xDA77…be4C`](https://testnet.monadscan.com/address/0xDA77bf9f41Cc3dFF4f966a1Fa2438CC3a5BBbe4C) ([deployment transaction](https://testnet.monadscan.com/tx/0x2dad894d59b1de6502ae482a98f03df3c8e77d9284c51d9ed5fbd808741c063e)).
- **Verifier:** https://touchgrass-verifier.touchgrass-adilhusain.workers.dev

The app’s `.env.example` already contains the live vault, mUSDC, and verifier addresses. Add only a thirdweb client ID before building.

## Demo in three minutes

1. Create the embedded wallet and add a little testnet MON for gas.
2. Tap **Mint 1,000 demo mUSDC**.
3. Set a 7-day, 3-hour plan with a 1 mUSDC daily allowance.
4. Approve then lock the 7 mUSDC budget. Show the `ProgramCreated` event on MonadScan.
5. Show Android Usage Access and the on-device “Today” time card.
6. Submit a successful completed day. The verifier returns a signed voucher and the vault releases 1 mUSDC.
7. Explain that a missed day does not vanish: it waits as savings until the program and 7-day cooldown finish.

## Repository map

```text
apps/mobile     Android-first Expo app, thirdweb embedded wallet, UsageStatsManager
apps/verifier   Hono Cloudflare Worker, D1 replay protection, EIP-712 voucher signer
contracts       Foundry contracts: AllowanceVault + MockUSDC, including accounting tests
site            Static Vercel-ready landing page and APK-release download link
```

## Run locally

### Mobile app

```sh
cd apps/mobile
pnpm install
cp .env.example .env
# Set EXPO_PUBLIC_THIRDWEB_CLIENT_ID in .env
EXPO_USE_COMMUNITY_AUTOLINKING=1 pnpm exec expo prebuild --platform android
EXPO_USE_COMMUNITY_AUTOLINKING=1 pnpm exec expo run:android
```

TouchGrass uses Android `UsageStatsManager`, so it will not run in Expo Go. Enable Usage Access for TouchGrass on first launch.

### Verifier

```sh
cd apps/verifier
pnpm install
pnpm exec wrangler d1 migrations apply touchgrass-verifier --remote
pnpm exec wrangler secret put VERIFIER_PRIVATE_KEY
pnpm exec wrangler secret put VAULT_ADDRESS
pnpm deploy
```

`VERIFIER_PRIVATE_KEY` belongs only in a Cloudflare secret. Its public address must be passed to the vault constructor.

### Contracts

```sh
cd contracts
forge test
```

For a new testnet deployment, use a funded disposable deployer and the official Monad testnet RPC. Deploy `MockUSDC` first, then deploy `AllowanceVault(verifier, mockUsdc)` with Foundry’s `forge create`. Never place deployment or verifier private keys in Git, the app, or an `EXPO_PUBLIC_*` variable.

## Checks completed

- Five Foundry tests covering budget custody, approval failure, single claim, invalid/early voucher rejection, and cooldown withdrawal.
- Verifier TypeScript check.
- Mobile TypeScript check, Expo lint, and Android native prebuild.
- Live contract reads confirming the active vault’s mUSDC asset and verifier signer.

## Honest MVP boundaries

- Android only. iOS Screen Time needs Apple’s Family Controls entitlement and extensions.
- The verifier blocks duplicate vouchers; it cannot make consumer usage data trustless against the device owner.
- The current token is intentionally permissionless mock USDC. Real money, selected-app rules, social accountability, leaderboards, and the “journal only after a good day” ritual are future milestones.

TouchGrass is deliberately small: one meaningful daily decision, one budget, and a little more room for real life.
