import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import {
  createPublicClient,
  http,
  isAddress,
  type Address,
  type Hex,
  verifyMessage,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

type Bindings = {
  DB: D1Database;
  VERIFIER_PRIVATE_KEY: Hex;
  VAULT_ADDRESS: Address;
  ALLOWED_ORIGIN?: string;
};

type ProgramRecord = {
  program_id: string;
  wallet: string;
  beneficiary: string;
  start_at: number;
  duration_days: number;
  daily_limit_seconds: number;
  timezone: string;
  installation_id: string;
};

const CHAIN_ID = 10143;
const DAY_MS = 86_400_000;
const rpc = "https://monad-testnet.drpc.org";
const vaultAbi = [
  {
    type: "function",
    name: "programs",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "owner", type: "address" },
      { name: "beneficiary", type: "address" },
      { name: "startAt", type: "uint64" },
      { name: "durationDays", type: "uint16" },
      { name: "dailyLimitSeconds", type: "uint32" },
      { name: "dailyAmount", type: "uint96" },
      { name: "claimedBitmap", type: "uint256" },
    ],
  },
] as const;

const app = new Hono<{ Bindings: Bindings }>();

app.use("/v1/*", async (c, next) => {
  return cors({ origin: c.env.ALLOWED_ORIGIN || "*" })(c, next);
});

app.get("/", (c) => c.json({ name: "TouchGrass verifier", chainId: CHAIN_ID, status: "ok" }));

app.post("/v1/programs/register", async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const programId = asProgramId(body?.programId);
  const wallet = asAddress(body?.wallet);
  const timezone = asShortString(body?.timezone, 100);
  const installationId = asInstallationId(body?.installationId);
  const signature = asHex(body?.walletSignature);
  if (!programId || !wallet || !timezone || !installationId || !signature) return badRequest(c, "Invalid registration payload");
  if (!isConfigured(c.env)) return c.json({ error: "Verifier is not configured" }, 503);

  const message = registrationMessage(programId, wallet, timezone, installationId);
  if (!(await verifyMessage({ address: wallet, message, signature }))) return badRequest(c, "Wallet signature is invalid");

  const chainProgram = await readProgram(c.env.VAULT_ADDRESS, BigInt(programId)).catch(() => null);
  if (!chainProgram || chainProgram[0].toLowerCase() !== wallet.toLowerCase()) {
    return badRequest(c, "Program does not belong to this wallet");
  }

  const [owner, beneficiary, startAt, durationDays, dailyLimitSeconds] = chainProgram;
  await c.env.DB.prepare(
    `INSERT INTO programs (program_id, wallet, beneficiary, start_at, duration_days, daily_limit_seconds, timezone, installation_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(program_id) DO UPDATE SET timezone = excluded.timezone, installation_id = excluded.installation_id`
  ).bind(
    programId,
    owner.toLowerCase(),
    beneficiary.toLowerCase(),
    Number(startAt),
    Number(durationDays),
    Number(dailyLimitSeconds),
    timezone,
    installationId,
    Date.now(),
  ).run();

  return c.json({ programId, registered: true });
});

app.post("/v1/verify-day", async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const programId = asProgramId(body?.programId);
  const wallet = asAddress(body?.wallet);
  const dayIndex = asDayIndex(body?.dayIndex);
  const usageSeconds = asNonNegativeInt(body?.usageSeconds);
  const periodStart = asUnixMs(body?.periodStart);
  const periodEnd = asUnixMs(body?.periodEnd);
  const installationId = asInstallationId(body?.installationId);
  const signature = asHex(body?.walletSignature);
  if (
    !programId || !wallet || dayIndex === null || usageSeconds === null || !periodStart || !periodEnd || !installationId || !signature
  ) return badRequest(c, "Invalid daily report");
  if (!isConfigured(c.env)) return c.json({ error: "Verifier is not configured" }, 503);

  const program = await c.env.DB.prepare(
    "SELECT * FROM programs WHERE program_id = ?"
  ).bind(programId).first<ProgramRecord>();
  if (!program || program.wallet !== wallet.toLowerCase() || program.installation_id !== installationId) {
    return badRequest(c, "Program is not registered on this device");
  }
  if (dayIndex >= program.duration_days) return badRequest(c, "Day is outside the program");
  if (periodEnd <= periodStart || periodEnd - periodStart > DAY_MS + 3_600_000) return badRequest(c, "Invalid report window");

  const expectedClose = Number(program.start_at) * 1_000 + (dayIndex + 1) * DAY_MS;
  if (Date.now() < expectedClose || periodEnd < expectedClose - 3_600_000) {
    return badRequest(c, "This program day has not closed yet");
  }

  const message = checkInMessage({ programId, wallet, dayIndex, usageSeconds, periodStart, periodEnd, installationId });
  if (!(await verifyMessage({ address: wallet, message, signature }))) return badRequest(c, "Wallet signature is invalid");

  if (usageSeconds > program.daily_limit_seconds) {
    return c.json({ eligible: false, reason: "Daily target was exceeded; the allowance stays in savings." }, 200);
  }

  const existing = await c.env.DB.prepare(
    "SELECT signature, valid_until FROM vouchers WHERE program_id = ? AND day_index = ?"
  ).bind(programId, dayIndex).first<{ signature: string; valid_until: number }>();
  if (existing) return c.json({ eligible: true, voucher: { dayIndex, validUntil: existing.valid_until, signature: existing.signature } });

  const validUntil = Math.floor(Date.now() / 1_000) + 86_400;
  const account = privateKeyToAccount(c.env.VERIFIER_PRIVATE_KEY);
  const voucherSignature = await account.signTypedData({
    domain: { name: "TouchGrassAllowanceVault", version: "1", chainId: CHAIN_ID, verifyingContract: c.env.VAULT_ADDRESS },
    types: {
      ClaimVoucher: [
        { name: "programId", type: "uint256" },
        { name: "beneficiary", type: "address" },
        { name: "dayIndex", type: "uint16" },
        { name: "validUntil", type: "uint64" },
      ],
    },
    primaryType: "ClaimVoucher",
    message: { programId: BigInt(programId), beneficiary: program.beneficiary as Address, dayIndex, validUntil: BigInt(validUntil) },
  });

  await c.env.DB.prepare(
    "INSERT INTO vouchers (program_id, day_index, usage_seconds, period_start, period_end, signature, valid_until, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(programId, dayIndex, usageSeconds, periodStart, periodEnd, voucherSignature, validUntil, Date.now()).run();

  return c.json({ eligible: true, voucher: { dayIndex, validUntil, signature: voucherSignature } });
});

function isConfigured(env: Bindings) {
  return Boolean(env.VERIFIER_PRIVATE_KEY && env.VAULT_ADDRESS && isAddress(env.VAULT_ADDRESS));
}

async function readProgram(vault: Address, programId: bigint) {
  const client = createPublicClient({ transport: http(rpc) });
  return client.readContract({ address: vault, abi: vaultAbi, functionName: "programs", args: [programId] });
}

function registrationMessage(programId: string, wallet: Address, timezone: string, installationId: string) {
  return `TouchGrass program registration\nprogram: ${programId}\nwallet: ${wallet.toLowerCase()}\ntimezone: ${timezone}\ndevice: ${installationId}`;
}

function checkInMessage(input: { programId: string; wallet: Address; dayIndex: number; usageSeconds: number; periodStart: number; periodEnd: number; installationId: string }) {
  return `TouchGrass daily check-in\nprogram: ${input.programId}\nwallet: ${input.wallet.toLowerCase()}\nday: ${input.dayIndex}\nusageSeconds: ${input.usageSeconds}\nperiodStart: ${input.periodStart}\nperiodEnd: ${input.periodEnd}\ndevice: ${input.installationId}`;
}

function badRequest(c: Context<{ Bindings: Bindings }>, error: string) {
  return c.json({ error }, 400);
}

function asAddress(value: unknown): Address | null {
  return typeof value === "string" && isAddress(value) ? value as Address : null;
}
function asProgramId(value: unknown): string | null {
  return typeof value === "string" && /^\d+$/.test(value) ? value : null;
}
function asHex(value: unknown): Hex | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value) ? value as Hex : null;
}
function asShortString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max ? value.trim() : null;
}
function asInstallationId(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{16,128}$/.test(value) ? value : null;
}
function asDayIndex(value: unknown): number | null {
  return Number.isInteger(value) && typeof value === "number" && value >= 0 && value < 28 ? value : null;
}
function asNonNegativeInt(value: unknown): number | null {
  return Number.isInteger(value) && typeof value === "number" && value >= 0 && value <= 86_400 ? value : null;
}
function asUnixMs(value: unknown): number | null {
  return Number.isInteger(value) && typeof value === "number" && value > 1_600_000_000_000 && value < 4_000_000_000_000 ? value : null;
}

export default app;
