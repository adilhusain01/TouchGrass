# TouchGrass

TouchGrass is an Android-first commitment vault for people who want less phone time and less impulsive spending. Lock testnet MON; when a completed day stays below your app-use target, a verifier issues a voucher and the vault releases that day’s allowance. Missed allowances stay locked as savings until the program ends and its cooldown passes.

> Testnet only. MON on Monad Testnet has no monetary value. TouchGrass is a voluntary self-accountability tool, not a trustless proof of screen time.

## What is included

- `apps/mobile` — Expo / React Native Android app, generated from Monad’s Expo + thirdweb starter and redesigned for TouchGrass.
- `contracts` — Foundry + OpenZeppelin `AllowanceVault`, which custody-locks native MON and verifies EIP-712 daily claim vouchers.
- `apps/verifier` — Hono Cloudflare Worker with D1 persistence. It stores only aggregate daily seconds, program metadata, and issued-voucher state.

## Run it locally

### 1. Contract

```sh
cd contracts
forge test
cp .env.example .env
# Add MONAD_RPC_URL, DEPLOYER_PRIVATE_KEY, and the verifier wallet address locally.
forge script script/DeployAllowanceVault.s.sol:DeployAllowanceVault \
  --rpc-url "$MONAD_RPC_URL" --broadcast --verify
```

The deployer key belongs only in an ignored `.env`. Never place a private key in Git, app code, a Worker variable, or an `EXPO_PUBLIC_*` value.

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

1. Create an embedded wallet and request testnet MON from the Monad faucet.
2. Choose a 7/14/28-day plan, app-use target, and daily MON release.
3. Create the vault on Monad Testnet; show the `ProgramCreated` event in the explorer.
4. After a successful day, submit the verifier voucher and show the claim transaction.
5. Show that a missed day stays locked and that analytics remain local to the phone.

## Known MVP boundaries

- Android only; iOS Screen Time requires Apple Family Controls entitlement and extensions.
- A phone owner can manipulate their own device data. The verifier prevents replay/double claims, but does not turn consumer screen-time data into a cryptographic oracle.
- Journaling, social accountability, selected-app tracking, and real money are intentionally future milestones.
