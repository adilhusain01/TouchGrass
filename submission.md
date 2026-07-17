# TouchGrass — Hackathon Submission

## Description

### Four problems I could not solve with willpower

I built TouchGrass because I was stuck in four connected loops:

1. Doomscrolling: high screen time, low productivity.
2. Spending too much on food and small impulses until my money is gone.
3. Avoiding journaling because a screen-heavy day leaves little that feels worth reflecting on.
4. Ending the day without a clear plan for tomorrow.

I want to solve this for myself—and for anyone caught in the same loop.

TouchGrass is a screen-time commitment vault: when a day disappears into a phone, money that is easy to reach often disappears too.

Most screen-time limits ask for willpower at the exact moment a feed is designed to defeat it. TouchGrass moves that decision upstream. A user chooses a realistic Android screen-time limit, locks a small mUSDC budget for 7, 14, or 28 days, and earns one daily allowance back only after completing the day as intended.

The ritual is deliberately small: stay under the limit, write a 300-character reflection, spend two active minutes writing, and make at least three tasks for tomorrow. On the following day, the app submits only the aggregate proof—screen-time seconds, character count, writing seconds, and task count. The journal and task content never leave the device.

Monad holds the budget transparently. A verifier prevents duplicate claims and signs a one-time voucher; the vault releases that day’s mUSDC when the conditions are met. Miss a day, and the allowance is not burned or gambled away—it remains savings, withdrawable after the program and cooldown finish.

**MON pays gas. mUSDC is the budget and daily reward.**

> Testnet MVP only. MON and mUSDC on Monad Testnet have no real-world value. TouchGrass is voluntary self-accountability: it prevents duplicate claims, but cannot cryptographically prove a device owner has not manipulated their own usage data.

### The loop

```text
Mint demo mUSDC → lock a 7 / 14 / 28-day budget on Monad
       ↓
Android measures interactive, unlocked screen time
       ↓
Reflect: 300 characters + 2 active minutes + 3 tomorrow tasks
       ↓
Next day: sign one aggregate check-in
       ↓
Verifier prevents replay and signs one claim voucher
       ↓
Phone use ≤ target + reflection complete → daily mUSDC released
Otherwise → that allowance stays saved in the vault
```

## What problem are you trying to solve?

Phone overuse and impulsive spending reinforce each other: hours disappear into scrolling, then money that is immediately available disappears too. Most screen-time apps rely on willpower when attention is weakest, so limits are easy to override and quickly lose meaning.

## How is your project the solution to your problem?

TouchGrass turns intention into a small daily commitment. Users lock a mUSDC budget upfront, choose a screen-time limit, and earn each day’s allowance only by staying under it, reflecting on the day, and planning tomorrow. Monad custody makes the commitment transparent; Android provides the on-device signal; and a verifier issues one replay-safe claim voucher per completed day. A miss becomes protected savings, not punishment—creating a calmer loop of less scroll, more day, and more deliberate spending.
