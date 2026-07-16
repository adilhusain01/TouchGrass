# TouchGrass

TouchGrass is an Android-first commitment vault for people who want less phone time and less impulsive spending. Lock mock USDC; when a completed day stays below your app-use target, a verifier issues a voucher and the vault releases that day’s allowance. MON pays only network gas. Missed allowances stay locked as savings until the program ends and its cooldown passes.

> Testnet only. MON on Monad Testnet has no monetary value. TouchGrass is a voluntary self-accountability tool, not a trustless proof of screen time.

## What is included

- `apps/mobile` — Expo / React Native Android app, generated from Monad’s Expo + thirdweb starter and redesigned for TouchGrass.
- `contracts` — Foundry + OpenZeppelin `AllowanceVault` and a 6-decimal `mUSDC` faucet token. The vault custody-locks mUSDC and verifies EIP-712 daily claim vouchers.
- `apps/verifier` — Hono Cloudflare Worker with D1 persistence. It stores only aggregate daily seconds, program metadata, and issued-voucher state.

## Run it locally

### 1. Contract

```sh
cd contracts
forge test
cp .env.example .env
# Add MONAD_RPC_URL, DEPLOYER_PRIVATE_KEY, and the verifier wallet address locally.
# The contract is currently optimized to cost roughly 0.11 MON to deploy at a 102 gwei gas price;
# fund the disposable testnet deployer with at least 0.20 MON before broadcasting.
forge script script/DeployAllowanceVault.s.sol:DeployAllowanceVault \
  --rpc-url "$MONAD_RPC_URL" --broadcast --skip-simulation
```

The deployer key belongs only in an ignored `.env`. Never place a private key in Git, app code, a Worker variable, or an `EXPO_PUBLIC_*` value.

Active Monad Testnet contracts:

- [`mUSDC faucet`](https://testnet.monadscan.com/address/0x59E68C80762c7eC8F1172eD893b32947dacf9Ad1) — 6 decimals; anyone can mint 1,000 test mUSDC.
- [`AllowanceVault`](https://testnet.monadscan.com/address/0xDA77bf9f41Cc3dFF4f966a1Fa2438CC3a5BBbe4C) ([deployment transaction](https://testnet.monadscan.com/tx/0x2dad894d59b1de6502ae482a98f03df3c8e77d9284c51d9ed5fbd808741c063e)).

### 2. Verifier

```sh
cd apps/verifier
pnpm install
npx wrangler d1 create touchgrass-verifier
# Put the returned database_id into wrangler.jsonc.
npx wrangler d1 migrations apply touchgrass-verifier --remote
npx wrangler secret put VERIFIER_PRIVATE_KEY
npx wrangler secret put VAULT_ADDRESS
pnpm deploy
```

Use a fresh verifier wallet. Its public address is the `VERIFIER_ADDRESS` used during contract deployment.
The deployed endpoint is `https://touchgrass-verifier.touchgrass-adilhusain.workers.dev`; set it as
`EXPO_PUBLIC_VERIFIER_URL` in the mobile app. The service is live and configured against the
deployed vault.

### 3. Android app

```sh
cd apps/mobile
pnpm install
cp .env.example .env
# Add THIRDWEB_CLIENT_ID, vault address, and deployed verifier URL.
npx expo prebuild --platform android
npx expo run:android
```

TouchGrass uses `UsageStatsManager`, so it **will not run in Expo Go**. On first launch, open Android Usage Access from the app and enable TouchGrass. The app measures aggregate foreground time for the current day and excludes itself.

## Verification

```sh
cd contracts && forge test
cd ../apps/verifier && pnpm exec tsc --noEmit
cd ../mobile && pnpm exec tsc --noEmit && pnpm exec expo lint
```

## Demo sequence

1. Create an embedded wallet, request a little testnet MON for gas, then mint demo mUSDC.
2. Choose a 7/14/28-day plan, app-use target, and daily mUSDC release.
3. Create the vault on Monad Testnet; show the `ProgramCreated` event in the explorer.
4. After a successful day, submit the verifier voucher and show the claim transaction.
5. Show that a missed day stays locked and that analytics remain local to the phone.

## Known MVP boundaries

- Android only; iOS Screen Time requires Apple Family Controls entitlement and extensions.
- A phone owner can manipulate their own device data. The verifier prevents replay/double claims, but does not turn consumer screen-time data into a cryptographic oracle.
- Journaling, social accountability, selected-app tracking, and real money are intentionally future milestones.
