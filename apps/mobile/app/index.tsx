import AsyncStorage from "@react-native-async-storage/async-storage";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useState } from "react";
import Animated, {
  Easing,
  FadeInDown,
  FadeOutUp,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import {
  AppState,
  Alert,
  Image,
  Linking,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  ConnectButton,
  useActiveAccount,
  useSendTransaction,
  useWalletBalance,
} from "thirdweb/react";
import { inAppWallet } from "thirdweb/wallets";
import {
  getContract,
  prepareContractCall,
  readContract,
  toTokens,
  toUnits,
} from "thirdweb";

import {
  chain,
  getClient,
  mockUsdcAddress,
  vaultAddress,
  verifierUrl,
} from "@/constants/thirdweb";

type Tab = "today" | "reflect" | "setup" | "vault" | "insights";
type ProgramSettings = {
  duration: 7 | 14 | 28;
  targetHours: number;
  dailyUsdc: string;
  programId: string;
  startAt?: number;
};
type OnchainProgram = {
  id: bigint;
  startAt: number;
  durationDays: number;
  dailyLimitSeconds: number;
  dailyAmount: bigint;
  claimedBitmap: bigint;
};
type TomorrowPlan = { must: string[]; should: string[]; ifTime: string[] };
type JournalRecord = {
  dayStart: number;
  text: string;
  activeSeconds: number;
  plan: TomorrowPlan;
  updatedAt: number;
};

const SETTINGS_KEY = "touchgrass.settings.v1";
const INSTALLATION_KEY = "touchgrass.installation-id.v1";
const JOURNAL_DAYS_KEY = "touchgrass.journal-days.v1";
const ink = "#17140E";
const paper = "#F4EEDF";
const line = "#D4CCBC";
const moss = "#56734B";
const softMoss = "#E5EAD8";
const client = getClient();
const defaultSettings: ProgramSettings = {
  duration: 14,
  targetHours: 3,
  dailyUsdc: "1",
  programId: "",
};
const blankJournal = (dayStart = dateStart()): JournalRecord => ({
  dayStart,
  text: "",
  activeSeconds: 0,
  plan: { must: [], should: [], ifTime: [] },
  updatedAt: Date.now(),
});

function dateStart() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function formatMinutes(seconds: number) {
  const minutes = Math.max(0, Math.floor(seconds / 60));
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function truncate(address?: string) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "";
}

function formatUsdc(amount?: bigint) {
  return amount === undefined ? "—" : Number(toTokens(amount, 6)).toFixed(2);
}

function lockedAmount(program?: OnchainProgram) {
  if (!program) return 0n;
  let claimedDays = 0;
  for (let day = 0; day < program.durationDays; day += 1) {
    if ((program.claimedBitmap & (1n << BigInt(day))) !== 0n) claimedDays += 1;
  }
  return program.dailyAmount * BigInt(program.durationDays - claimedDays);
}

function journalKey(dayStart: number) {
  return `touchgrass.journal.${dayStart}.v1`;
}

function journalTaskCount(journal: JournalRecord) {
  return (
    journal.plan.must.length +
    journal.plan.should.length +
    journal.plan.ifTime.length
  );
}

async function readJournal(dayStart: number) {
  const saved = await AsyncStorage.getItem(journalKey(dayStart));
  return saved ? (JSON.parse(saved) as JournalRecord) : undefined;
}

async function saveJournal(journal: JournalRecord) {
  await AsyncStorage.setItem(
    journalKey(journal.dayStart),
    JSON.stringify(journal),
  );
  const days = JSON.parse(
    (await AsyncStorage.getItem(JOURNAL_DAYS_KEY)) ?? "[]",
  ) as number[];
  if (!days.includes(journal.dayStart))
    await AsyncStorage.setItem(
      JOURNAL_DAYS_KEY,
      JSON.stringify([...days, journal.dayStart].sort((a, b) => b - a)),
    );
}

async function readTodayUsage(): Promise<number | null> {
  return readUsageFor(dateStart(), Date.now());
}

async function readUsageFor(
  startTime: number,
  endTime: number,
): Promise<number | null> {
  if (Platform.OS !== "android") return null;
  // The package only exists in Android development builds, never in Expo Go.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const module = require("@antardev/react-native-usage-stats");
  const usageStats = module.default ?? module;
  if (!usageStats.isPermissionGranted()) return null;
  const events = (await usageStats.queryEvents({ startTime, endTime })) as {
    eventType: number;
    packageName: string;
    timeStamp: number;
  }[];
  if (events.length === 0) return null;

  const eventType = module.UsageEventType;
  const screenSegments: [number, number][] = [];
  let interactive = false;
  let unlocked = false;
  let screenStartedAt: number | null = null;

  const updateScreenSegment = (time: number) => {
    const active = interactive && unlocked;
    if (active && screenStartedAt === null) screenStartedAt = time;
    if (!active && screenStartedAt !== null) {
      screenSegments.push([screenStartedAt, time]);
      screenStartedAt = null;
    }
  };

  for (const event of events.sort((a, b) => a.timeStamp - b.timeStamp)) {
    const time = Math.min(Math.max(event.timeStamp, startTime), endTime);
    if (event.eventType === eventType.SCREEN_INTERACTIVE) interactive = true;
    else if (event.eventType === eventType.SCREEN_NON_INTERACTIVE)
      interactive = false;
    else if (event.eventType === eventType.KEYGUARD_HIDDEN) unlocked = true;
    else if (event.eventType === eventType.KEYGUARD_SHOWN) unlocked = false;
    updateScreenSegment(time);
  }
  updateScreenSegment(endTime);

  const screenMs = screenSegments.reduce(
    (total, [start, end]) => total + end - start,
    0,
  );
  return Math.round(screenMs / 1_000);
}

async function installationId() {
  const existing = await AsyncStorage.getItem(INSTALLATION_KEY);
  if (existing) return existing;
  const created = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  await AsyncStorage.setItem(INSTALLATION_KEY, created);
  return created;
}

export default function TouchGrass() {
  const account = useActiveAccount();
  const { mutate: sendTransaction, isPending } = useSendTransaction();
  const [tab, setTab] = useState<Tab>("today");
  const [usageSeconds, setUsageSeconds] = useState<number | null>(null);
  const [weekUsage, setWeekUsage] = useState<number[]>([]);
  const [program, setProgram] = useState<OnchainProgram>();
  const [freeUsdc, setFreeUsdc] = useState<bigint>();
  const [hasUsageAccess, setHasUsageAccess] = useState(false);
  const [settings, setSettings] = useState<ProgramSettings>(defaultSettings);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isCheckingIn, setIsCheckingIn] = useState(false);
  const [journal, setJournal] = useState<JournalRecord>(blankJournal);
  const [journalHistory, setJournalHistory] = useState<JournalRecord[]>([]);
  const [journalLoaded, setJournalLoaded] = useState(false);
  const [isWriting, setIsWriting] = useState(false);
  const [justPlanted, setJustPlanted] = useState(false);

  const { data: balance, refetch: refetchBalance } = useWalletBalance({
    client,
    address: account?.address,
    chain,
  });

  const refreshProgram = useCallback(async () => {
    if (!account?.address || !vaultAddress || !mockUsdcAddress) {
      setProgram(undefined);
      setFreeUsdc(undefined);
      return;
    }
    const vault = getContract({ client, chain, address: vaultAddress });
    const usdc = getContract({ client, chain, address: mockUsdcAddress });
    const [nextProgramId, walletBalance] = await Promise.all([
      readContract({
        contract: vault,
        method: "function nextProgramId() view returns (uint256)",
      }),
      readContract({
        contract: usdc,
        method: "function balanceOf(address) view returns (uint256)",
        params: [account.address],
      }),
    ]);
    setFreeUsdc(walletBalance);
    // ponytail: scan the small testnet program list; add an owner index to the contract when this is multi-user.
    const ids = Array.from(
      { length: Math.min(Number(nextProgramId), 50) },
      (_, index) => BigInt(index),
    );
    const programs = await Promise.all(
      ids.map(async (id) => {
        const result = (await readContract({
          contract: vault,
          method:
            "function programs(uint256) view returns (address owner,address beneficiary,uint64 startAt,uint16 durationDays,uint32 dailyLimitSeconds,uint96 dailyAmount,uint256 claimedBitmap)",
          params: [id],
        })) as unknown as readonly [
          string,
          string,
          bigint,
          bigint,
          bigint,
          bigint,
          bigint,
        ];
        if (result[0].toLowerCase() !== account.address.toLowerCase())
          return undefined;
        return {
          id,
          startAt: Number(result[2]),
          durationDays: Number(result[3]),
          dailyLimitSeconds: Number(result[4]),
          dailyAmount: result[5],
          claimedBitmap: result[6],
        } satisfies OnchainProgram;
      }),
    );
    const latest = programs
      .filter((candidate): candidate is OnchainProgram => Boolean(candidate))
      .at(-1);
    setProgram(latest);
    if (latest) {
      const onchainSettings = {
        duration: latest.durationDays as 7 | 14 | 28,
        targetHours: latest.dailyLimitSeconds / 3_600,
        dailyUsdc: toTokens(latest.dailyAmount, 6),
        programId: latest.id.toString(),
        startAt: latest.startAt,
      };
      setSettings(onchainSettings);
      void AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(onchainSettings));
    }
  }, [account?.address]);

  useEffect(() => {
    AsyncStorage.getItem(SETTINGS_KEY)
      .then((stored) => {
        if (stored) setSettings({ ...defaultSettings, ...JSON.parse(stored) });
        setIsLoaded(true);
      })
      .catch(() => setIsLoaded(true));
  }, []);
  useEffect(() => {
    const loadJournal = async () => {
      const today = dateStart();
      const current = (await readJournal(today)) ?? blankJournal(today);
      const days = JSON.parse(
        (await AsyncStorage.getItem(JOURNAL_DAYS_KEY)) ?? "[]",
      ) as number[];
      const records = (
        await Promise.all(days.slice(0, 7).map(readJournal))
      ).filter((record): record is JournalRecord => Boolean(record));
      setJournal(current);
      setJournalHistory(records);
      setJournalLoaded(true);
    };
    void loadJournal();
  }, []);
  useEffect(() => {
    if (!journalLoaded) return;
    const updated = { ...journal, updatedAt: Date.now() };
    void saveJournal(updated);
    setJournalHistory((entries) =>
      [
        updated,
        ...entries.filter((entry) => entry.dayStart !== updated.dayStart),
      ].sort((a, b) => b.dayStart - a.dayStart),
    );
  }, [journal, journalLoaded]);
  useEffect(() => {
    if (!isWriting || journal.text.trim().length === 0) return;
    const timer = setInterval(
      () =>
        setJournal((entry) => ({
          ...entry,
          activeSeconds: entry.activeSeconds + 1,
        })),
      1_000,
    );
    return () => clearInterval(timer);
  }, [isWriting, journal.text]);

  const refreshUsage = useCallback(async () => {
    if (Platform.OS !== "android") return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const module = require("@antardev/react-native-usage-stats");
    const usageStats = module.default ?? module;
    const allowed = Boolean(usageStats.isPermissionGranted());
    setHasUsageAccess(allowed);
    if (!allowed) {
      setUsageSeconds(null);
      return;
    }
    const total = await readTodayUsage();
    if (total !== null) {
      setUsageSeconds(total);
    }
  }, []);

  const refreshWeekUsage = useCallback(async () => {
    const todayStart = dateStart();
    const todayIndex = (new Date().getDay() + 6) % 7;
    const weekStart = todayStart - todayIndex * 86_400_000;
    const values = await Promise.all(
      Array.from({ length: 7 }, async (_, index) => {
        if (index > todayIndex) return 0;
        const start = weekStart + index * 86_400_000;
        const end = index === todayIndex ? Date.now() : start + 86_400_000;
        return (await readUsageFor(start, end)) ?? 0;
      }),
    );
    setWeekUsage(values);
  }, []);

  const refreshAnalytics = useCallback(async () => {
    await Promise.all([refreshUsage(), refreshWeekUsage()]);
  }, [refreshUsage, refreshWeekUsage]);

  useEffect(() => {
    void refreshUsage();
  }, [refreshUsage]);
  useEffect(() => {
    void refreshProgram();
  }, [refreshProgram]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshAnalytics();
    });
    return () => subscription.remove();
  }, [refreshAnalytics]);
  useEffect(() => {
    if (tab === "insights" && hasUsageAccess) void refreshAnalytics();
  }, [hasUsageAccess, refreshAnalytics, tab]);

  const copyWalletAddress = useCallback(async () => {
    if (!account?.address) return;
    await Clipboard.setStringAsync(account.address);
    Alert.alert("Wallet address copied", account.address);
  }, [account?.address]);

  const saveSettings = useCallback(async (next: ProgramSettings) => {
    setSettings(next);
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  }, []);

  const requestUsageAccess = () => {
    if (Platform.OS !== "android")
      return Alert.alert(
        "Android first",
        "TouchGrass needs Android Usage Access for this MVP.",
      );
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const module = require("@antardev/react-native-usage-stats");
    const usageStats = module.default ?? module;
    usageStats.requestPermission();
  };

  const createProgram = () => {
    if (!account)
      return Alert.alert(
        "Connect your wallet",
        "Create an embedded wallet first.",
      );
    if (
      program &&
      Date.now() < (program.startAt + program.durationDays * 86_400) * 1_000
    )
      return Alert.alert(
        "A plan is already growing",
        "Finish your current program before planting another one.",
      );
    if (!vaultAddress || !mockUsdcAddress)
      return Alert.alert(
        "Contracts not configured",
        "Add the vault and mUSDC addresses to your app environment.",
      );
    const amount = Number(settings.dailyUsdc);
    if (!Number.isFinite(amount) || amount <= 0)
      return Alert.alert(
        "Set a daily amount",
        "Use a positive mUSDC allowance.",
      );
    const startAt = Math.floor((dateStart() + 86_400_000) / 1_000);
    const dailyAmount = toUnits(settings.dailyUsdc, 6);
    const budget = dailyAmount * BigInt(settings.duration);
    const usdc = getContract({ client, chain, address: mockUsdcAddress });
    const contract = getContract({ client, chain, address: vaultAddress });
    const approve = prepareContractCall({
      contract: usdc,
      method: "function approve(address spender,uint256 amount) returns (bool)",
      params: [vaultAddress, budget],
    });
    const create = prepareContractCall({
      contract,
      method:
        "function createProgram(uint16 durationDays,uint32 dailyLimitSeconds,uint96 dailyAmount,address beneficiary,uint64 startAt) returns (uint256)",
      params: [
        settings.duration,
        Math.round(settings.targetHours * 3_600),
        dailyAmount,
        account.address,
        BigInt(startAt),
      ],
    });
    // thirdweb's React Native hook defaults to an ABI-less contract type;
    // the prepared transaction contains the concrete ABI method at runtime.
    sendTransaction(approve as never, {
      onSuccess: () => {
        sendTransaction(create as never, {
          onSuccess: () => {
            void saveSettings({ ...settings, startAt });
            void refetchBalance();
            void refreshProgram();
            setJustPlanted(true);
            setTab("today");
          },
          onError: (error) =>
            Alert.alert("Approval complete, vault failed", error.message),
        });
      },
      onError: (error) => Alert.alert("Could not approve mUSDC", error.message),
    });
  };

  const mintMockUsdc = () => {
    if (!mockUsdcAddress)
      return Alert.alert(
        "mUSDC not configured",
        "Add EXPO_PUBLIC_MOCK_USDC_ADDRESS after deployment.",
      );
    const usdc = getContract({ client, chain, address: mockUsdcAddress });
    const transaction = prepareContractCall({
      contract: usdc,
      method: "function mint()",
    });
    sendTransaction(transaction as never, {
      onSuccess: () => {
        void refreshProgram();
        Alert.alert(
          "1,000 mUSDC minted",
          "This is a test token for your TouchGrass budget.",
        );
      },
      onError: (error) =>
        Alert.alert(
          /insufficient balance/i.test(error.message)
            ? "Your TouchGrass wallet needs MON"
            : "Could not mint mUSDC",
          /insufficient balance/i.test(error.message)
            ? "Send a little Monad testnet MON to this embedded wallet. mUSDC is free; MON only pays the transaction fee."
            : error.message,
        ),
    });
  };

  const withdrawSavings = () => {
    if (!vaultAddress || !program)
      return Alert.alert(
        "No savings to withdraw",
        "Your current plan is still being loaded.",
      );
    const contract = getContract({ client, chain, address: vaultAddress });
    const transaction = prepareContractCall({
      contract,
      method: "function withdrawMaturedSavings(uint256 programId)",
      params: [program.id],
    });
    sendTransaction(transaction as never, {
      onSuccess: () => {
        void refetchBalance();
        void refreshProgram();
        Alert.alert(
          "Savings released",
          "Your matured locked mUSDC returned to your wallet.",
        );
      },
      onError: (error) => Alert.alert("Savings still locked", error.message),
    });
  };

  const checkInYesterday = async () => {
    if (!account || !vaultAddress || !verifierUrl || !program) {
      return Alert.alert(
        "No active plan",
        "Plant a plan first. TouchGrass will find it automatically after the transaction confirms.",
      );
    }
    if (!hasUsageAccess) return requestUsageAccess();
    setIsCheckingIn(true);
    try {
      const deviceId = await installationId();
      const timezone =
        Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const registrationMessage = `TouchGrass program registration\nprogram: ${program.id}\nwallet: ${account.address.toLowerCase()}\ntimezone: ${timezone}\ndevice: ${deviceId}`;
      const registrationSignature = await account.signMessage({
        message: registrationMessage,
      });
      const registration = await fetch(
        `${verifierUrl.replace(/\/$/, "")}/v1/programs/register`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            programId: program.id.toString(),
            wallet: account.address,
            timezone,
            installationId: deviceId,
            walletSignature: registrationSignature,
          }),
        },
      );
      if (!registration.ok)
        throw new Error(
          (await registration.json().catch(() => ({}))).error ??
            "Could not register the program",
        );

      const periodEnd = dateStart();
      const periodStart = periodEnd - 86_400_000;
      const dayIndex = Math.floor(
        (periodStart - program.startAt * 1_000) / 86_400_000,
      );
      if (dayIndex < 0)
        throw new Error("Your first program day has not closed yet.");
      const yesterday = await readUsageFor(periodStart, periodEnd);
      if (yesterday === null) throw new Error("Usage Access is not available.");
      const reflection = await readJournal(periodStart);
      const journalChars = reflection?.text.trim().length ?? 0;
      const journalSeconds = reflection?.activeSeconds ?? 0;
      const planItems = reflection ? journalTaskCount(reflection) : 0;
      if (
        !reflection ||
        journalChars < 300 ||
        journalSeconds < 120 ||
        planItems < 3
      ) {
        throw new Error(
          "Yesterday needs a 300-character reflection, two minutes of writing, and three tomorrow tasks before its allowance can be claimed.",
        );
      }
      const message = `TouchGrass daily check-in\nprogram: ${program.id}\nwallet: ${account.address.toLowerCase()}\nday: ${dayIndex}\nusageSeconds: ${yesterday}\njournalChars: ${journalChars}\njournalSeconds: ${journalSeconds}\nplanItems: ${planItems}\nperiodStart: ${periodStart}\nperiodEnd: ${periodEnd}\ndevice: ${deviceId}`;
      const walletSignature = await account.signMessage({ message });
      const response = await fetch(
        `${verifierUrl.replace(/\/$/, "")}/v1/verify-day`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            programId: program.id.toString(),
            wallet: account.address,
            dayIndex,
            usageSeconds: yesterday,
            journalChars,
            journalSeconds,
            planItems,
            periodStart,
            periodEnd,
            installationId: deviceId,
            walletSignature,
          }),
        },
      );
      const result = (await response.json()) as {
        eligible?: boolean;
        reason?: string;
        error?: string;
        voucher?: {
          dayIndex: number;
          validUntil: number;
          signature: `0x${string}`;
        };
      };
      if (!response.ok) throw new Error(result.error ?? "Verification failed");
      if (!result.eligible || !result.voucher)
        return Alert.alert(
          "Allowance held",
          result.reason ?? "Your allowance stays in savings today.",
        );

      const contract = getContract({ client, chain, address: vaultAddress });
      const transaction = prepareContractCall({
        contract,
        method:
          "function claim(uint256 programId,uint16 dayIndex,uint64 validUntil,bytes signature)",
        params: [
          program.id,
          result.voucher.dayIndex,
          BigInt(result.voucher.validUntil),
          result.voucher.signature,
        ],
      });
      sendTransaction(transaction as never, {
        onSuccess: () => {
          void refetchBalance();
          void refreshProgram();
          Alert.alert(
            "mUSDC released",
            "Your successful day is now recorded on Monad.",
          );
        },
        onError: (error) =>
          Alert.alert("Voucher received, claim failed", error.message),
      });
    } catch (error) {
      Alert.alert(
        "Check-in unavailable",
        error instanceof Error
          ? error.message
          : "Please try again when you are online.",
      );
    } finally {
      setIsCheckingIn(false);
    }
  };

  const planIsOpen = Boolean(
    program &&
    Date.now() < (program.startAt + program.durationDays * 86_400) * 1_000,
  );
  const planSettings = program
    ? {
        ...settings,
        duration: program.durationDays as 7 | 14 | 28,
        targetHours: program.dailyLimitSeconds / 3_600,
        dailyUsdc: toTokens(program.dailyAmount, 6),
      }
    : settings;
  const allowedSeconds = planSettings.targetHours * 3_600;
  const progress = Math.min((usageSeconds ?? 0) / allowedSeconds, 1);
  const remainingSeconds = Math.max(allowedSeconds - (usageSeconds ?? 0), 0);

  useEffect(() => {
    if (!justPlanted) return;
    const timer = setTimeout(() => setJustPlanted(false), 1_250);
    return () => clearTimeout(timer);
  }, [justPlanted]);

  if (!isLoaded)
    return (
      <View style={styles.loading}>
        <Text style={styles.logo}>TouchGrass</Text>
      </View>
    );

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.topbar}>
        <View style={styles.wordmark}>
          <Image
            source={require("@/assets/images/grass.png")}
            style={styles.headerGrass}
          />
          <Text style={styles.logo}>TouchGrass</Text>
        </View>
        {account ? (
          <Pressable style={styles.walletPill} onPress={copyWalletAddress}>
            <Text style={styles.mono}>{truncate(account.address)}</Text>
            <Ionicons name="copy-outline" size={13} color={ink} />
          </Pressable>
        ) : (
          <ConnectButton
            client={client}
            chain={chain}
            wallets={[inAppWallet({ auth: { options: ["email"] } })]}
            connectButton={{ label: "Create wallet" }}
          />
        )}
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {tab === "today" && (
          <Today
            usageSeconds={usageSeconds}
            hasUsageAccess={hasUsageAccess}
            progress={progress}
            remainingSeconds={remainingSeconds}
            settings={planSettings}
            program={program}
            planIsOpen={planIsOpen}
            onRefresh={refreshAnalytics}
            onRequestAccess={requestUsageAccess}
            onSetup={() => setTab("setup")}
            onCheckIn={checkInYesterday}
            checkingIn={isCheckingIn}
          />
        )}
        {tab === "reflect" && (
          <Reflect
            journal={journal}
            history={journalHistory.filter(
              (entry) => entry.dayStart !== journal.dayStart,
            )}
            isWriting={isWriting}
            onWriting={setIsWriting}
            onChange={setJournal}
          />
        )}
        {tab === "setup" && (
          <Setup
            settings={planSettings}
            locked={planIsOpen}
            onChange={(next) => void saveSettings(next)}
            onCreate={createProgram}
            onMint={mintMockUsdc}
            pending={isPending}
          />
        )}
        {tab === "vault" && (
          <Vault
            balance={balance?.displayValue}
            freeUsdc={freeUsdc}
            program={program}
            onWithdraw={withdrawSavings}
            pending={isPending}
          />
        )}
        {tab === "insights" && (
          <Insights
            usageSeconds={usageSeconds ?? 0}
            targetSeconds={allowedSeconds}
            weekUsage={weekUsage}
            onRefresh={refreshAnalytics}
          />
        )}
      </ScrollView>

      <View style={styles.nav}>
        <NavItem
          active={tab === "today"}
          icon="sunny-outline"
          label="Today"
          onPress={() => setTab("today")}
        />
        <NavItem
          active={tab === "reflect"}
          icon="book-outline"
          label="Reflect"
          onPress={() => setTab("reflect")}
        />
        <NavItem
          active={tab === "setup"}
          icon="leaf-outline"
          label="Plan"
          onPress={() => setTab("setup")}
        />
        <NavItem
          active={tab === "vault"}
          icon="lock-closed-outline"
          label="Vault"
          onPress={() => setTab("vault")}
        />
        <NavItem
          active={tab === "insights"}
          icon="pulse-outline"
          label="Insights"
          onPress={() => setTab("insights")}
        />
      </View>
      <PlantingMoment visible={justPlanted} />
    </SafeAreaView>
  );
}

function Today({
  usageSeconds,
  hasUsageAccess,
  progress,
  remainingSeconds,
  settings,
  program,
  planIsOpen,
  onRefresh,
  onRequestAccess,
  onSetup,
  onCheckIn,
  checkingIn,
}: {
  usageSeconds: number | null;
  hasUsageAccess: boolean;
  progress: number;
  remainingSeconds: number;
  settings: ProgramSettings;
  program?: OnchainProgram;
  planIsOpen: boolean;
  onRefresh: () => void;
  onRequestAccess: () => void;
  onSetup: () => void;
  onCheckIn: () => void;
  checkingIn: boolean;
}) {
  const hasUsageData = usageSeconds !== null;
  const aboveTarget = hasUsageData && progress >= 1;
  const heroOpacity = useSharedValue(1);
  const heroScale = useSharedValue(1);
  const heroOffset = useSharedValue(0);
  const fillScale = useSharedValue(Math.max(progress, 0.02));
  const heroStyle = useAnimatedStyle(() => ({
    opacity: heroOpacity.value,
    transform: [{ translateY: heroOffset.value }, { scale: heroScale.value }],
  }));
  const fillStyle = useAnimatedStyle(() => ({
    transform: [{ scaleX: fillScale.value }],
  }));

  useEffect(() => {
    heroOpacity.value = 0;
    heroScale.value = 0.98;
    heroOffset.value = 6;
    heroOpacity.value = withTiming(1, {
      duration: 220,
      easing: Easing.out(Easing.cubic),
    });
    heroScale.value = withTiming(1, {
      duration: 220,
      easing: Easing.out(Easing.cubic),
    });
    heroOffset.value = withTiming(0, {
      duration: 220,
      easing: Easing.out(Easing.cubic),
    });
  }, [aboveTarget, heroOffset, heroOpacity, heroScale]);
  useEffect(() => {
    fillScale.value = withTiming(Math.max(progress, 0.02), {
      duration: 180,
      easing: Easing.out(Easing.cubic),
    });
  }, [fillScale, progress]);

  return (
    <>
      <View style={styles.eyebrowRow}>
        <Text style={styles.eyebrow}>TODAY’S PATCH</Text>
        <Text style={styles.mono}>
          {new Date()
            .toLocaleDateString(undefined, { month: "short", day: "numeric" })
            .toUpperCase()}
        </Text>
      </View>
      <View style={styles.hero}>
        <Image
          source={require("@/assets/images/grass.png")}
          style={styles.grass}
          resizeMode="contain"
        />
        <Animated.View style={heroStyle}>
          <Text style={styles.heroTitle}>
            {aboveTarget ? "Come back\ntomorrow." : "Keep your day\nwide open."}
          </Text>
          <Text style={styles.heroCopy}>
            {aboveTarget
              ? "Today’s allowance is safe in savings."
              : "A small mUSDC allowance unlocks when your day closes under target."}
          </Text>
        </Animated.View>
      </View>
      <View style={styles.timeCard}>
        <Text style={styles.monoLabel}>
          {hasUsageAccess ? "TRACKED SCREEN TIME" : "USAGE ACCESS NEEDED"}
        </Text>
        <Text style={styles.time}>
          {hasUsageAccess
            ? hasUsageData
              ? formatMinutes(usageSeconds)
              : "Syncing…"
            : "—"}
        </Text>
        <View style={styles.track}>
          <Animated.View
            style={[
              styles.fill,
              styles.fillAnimated,
              fillStyle,
              { backgroundColor: aboveTarget ? "#9A6049" : moss },
            ]}
          />
        </View>
        <View style={styles.timeFooter}>
          <Text style={styles.small}>
            {hasUsageAccess
              ? hasUsageData
                ? `${formatMinutes(remainingSeconds)} left before your ${settings.targetHours}h limit`
                : "Reading Android screen time…"
              : "Give TouchGrass permission to read Android app-use time."}
          </Text>
          <Pressable onPress={hasUsageAccess ? onRefresh : onRequestAccess}>
            <Text style={styles.link}>
              {hasUsageAccess ? "Refresh" : "Allow"}
            </Text>
          </Pressable>
        </View>
        {/* {hasUsageAccess && (
          <Text style={[styles.small, { marginTop: 8 }]}>
            Interactive, unlocked device screen time.
          </Text>
        )} */}
      </View>
      <View style={styles.rule} />
      <View style={styles.releaseRow}>
        <View>
          <Text style={styles.eyebrow}>NEXT DAILY RELEASE</Text>
          <Text style={styles.release}>{settings.dailyUsdc} mUSDC</Text>
          <Text style={styles.small}>Locked until your day closes</Text>
        </View>
        <Pressable style={styles.outlineButton} onPress={onSetup}>
          <Text style={styles.outlineText}>Edit plan</Text>
        </Pressable>
      </View>
      {!program && (
        <Pressable style={styles.primaryButton} onPress={onSetup}>
          <Text style={styles.primaryText}>Plant a plan</Text>
        </Pressable>
      )}
      {program &&
        planIsOpen &&
        Date.now() >= (program.startAt + 86_400) * 1_000 && (
          <ClaimButton
            onPress={onCheckIn}
            disabled={checkingIn}
            label={
              checkingIn ? "Checking yesterday…" : "Claim yesterday’s allowance"
            }
          />
        )}
      {program &&
        planIsOpen &&
        Date.now() < (program.startAt + 86_400) * 1_000 && (
          <View style={styles.notice}>
            <Ionicons name="time-outline" size={19} color={moss} />
            <Text style={styles.noticeText}>
              Your first day is in progress. Come back tomorrow to claim its
              allowance if you stay under your limit.
            </Text>
          </View>
        )}
      {/* <Text style={styles.disclaimer}>TouchGrass is a voluntary commitment tool. Your app-use total stays on your device; only an aggregate result is sent when you check in.</Text> */}
    </>
  );
}

function Setup({
  settings,
  locked,
  onChange,
  onCreate,
  onMint,
  pending,
}: {
  settings: ProgramSettings;
  locked: boolean;
  onChange: (next: ProgramSettings) => void;
  onCreate: () => void;
  onMint: () => void;
  pending: boolean;
}) {
  return (
    <>
      <Text style={styles.pageTitle}>
        {locked ? "Your plan is growing." : "Plant a limit."}
      </Text>
      <Text style={styles.pageCopy}>
        {locked
          ? "Your commitment is locked until this program ends. Its settings cannot be changed mid-plan."
          : "Lock a small budget. Make it available only on days you made space for the real world."}
      </Text>
      <Text style={styles.eyebrow}>PROGRAM LENGTH</Text>
      <View style={styles.segment}>
        {([7, 14, 28] as const).map((days) => (
          <Pressable
            key={days}
            disabled={locked}
            style={[
              styles.segmentOption,
              settings.duration === days && styles.segmentActive,
              locked && styles.disabled,
            ]}
            onPress={() => onChange({ ...settings, duration: days })}
          >
            <Text
              style={[
                styles.segmentText,
                settings.duration === days && styles.segmentTextActive,
              ]}
            >
              {days} days
            </Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.eyebrow}>DAILY APP-USE LIMIT</Text>
      <View style={[styles.stepper, locked && styles.disabled]}>
        <Pressable
          disabled={locked}
          onPress={() =>
            onChange({
              ...settings,
              targetHours: Math.max(1, settings.targetHours - 1),
            })
          }
        >
          <Ionicons name="remove" size={21} color={ink} />
        </Pressable>
        <Text style={styles.stepperValue}>
          {settings.targetHours}
          <Text style={styles.stepperUnit}> hours</Text>
        </Text>
        <Pressable
          disabled={locked}
          onPress={() =>
            onChange({
              ...settings,
              targetHours: Math.min(8, settings.targetHours + 1),
            })
          }
        >
          <Ionicons name="add" size={21} color={ink} />
        </Pressable>
      </View>
      <Text style={styles.eyebrow}>DAILY mUSDC RELEASE</Text>
      <View style={[styles.inputShell, locked && styles.disabled]}>
        <TextInput
          style={styles.input}
          editable={!locked}
          value={settings.dailyUsdc}
          onChangeText={(dailyUsdc) => onChange({ ...settings, dailyUsdc })}
          keyboardType="decimal-pad"
        />
        <Text style={styles.mono}>mUSDC</Text>
      </View>
      <View style={styles.totalCard}>
        <Text style={styles.small}>YOU’LL LOCK</Text>
        <Text style={styles.total}>
          {(Number(settings.dailyUsdc || 0) * settings.duration).toFixed(2)}{" "}
          mUSDC
        </Text>
        <Text style={styles.small}>
          Unused daily releases return after a 7-day cooldown. MON pays only
          gas.
        </Text>
      </View>
      <Pressable
        style={styles.outlineFullButton}
        onPress={onMint}
        disabled={pending}
      >
        <Text style={styles.outlineText}>Mint 1,000 demo mUSDC</Text>
      </Pressable>
      {!locked && (
        <Pressable
          style={styles.primaryButton}
          onPress={onCreate}
          disabled={pending}
        >
          <Text style={styles.primaryText}>
            {pending ? "Planting your patch…" : "Lock this plan"}
          </Text>
        </Pressable>
      )}
    </>
  );
}

function Vault({
  balance,
  freeUsdc,
  program,
  onWithdraw,
  pending,
}: {
  balance?: string;
  freeUsdc?: bigint;
  program?: OnchainProgram;
  onWithdraw: () => void;
  pending: boolean;
}) {
  return (
    <>
      <Text style={styles.pageTitle}>Your vault.</Text>
      <Text style={styles.pageCopy}>
        The contract holds only what you choose to lock. TouchGrass cannot see
        or move other wallet funds.
      </Text>
      <View style={styles.balanceCard}>
        <Text style={styles.monoLabel}>MON GAS BALANCE</Text>
        <Text style={styles.balance}>
          {balance ?? "—"}
          <Text style={styles.balanceUnit}> MON</Text>
        </Text>
        <Text style={styles.small}>
          Your locked allowance is mUSDC · Monad Testnet
        </Text>
      </View>
      <View style={styles.statGrid}>
        <Stat label="AVAILABLE mUSDC" value={`${formatUsdc(freeUsdc)}`} />
        <Stat
          label="LOCKED IN PLAN"
          value={`${formatUsdc(lockedAmount(program))}`}
        />
      </View>
      <View style={styles.notice}>
        <Ionicons name="information-circle-outline" size={19} color={moss} />
        <Text style={styles.noticeText}>
          {program
            ? `${formatUsdc(lockedAmount(program))} mUSDC remains in your current plan. Unreleased savings return after the program ends and its 7-day cooldown.`
            : "When you lock a plan, its mUSDC balance will appear here. MON is never locked."}
        </Text>
      </View>
      {program && (
        <Pressable
          style={styles.outlineFullButton}
          onPress={onWithdraw}
          disabled={pending}
        >
          <Text style={styles.outlineText}>
            {pending ? "Checking vault…" : "Withdraw matured savings"}
          </Text>
        </Pressable>
      )}
      <Pressable onPress={() => Linking.openURL("https://faucet.monad.xyz")}>
        <Text style={[styles.link, { marginTop: 22, textAlign: "center" }]}>
          Get testnet MON ↗
        </Text>
      </Pressable>
    </>
  );
}

function Insights({
  usageSeconds,
  targetSeconds,
  weekUsage,
  onRefresh,
}: {
  usageSeconds: number;
  targetSeconds: number;
  weekUsage: number[];
  onRefresh: () => void;
}) {
  const todayIndex = (new Date().getDay() + 6) % 7;
  const sample = Array.from({ length: 7 }, (_, index) =>
    index === todayIndex ? usageSeconds : (weekUsage[index] ?? 0),
  );
  const chartMax = Math.max(6 * 3_600, ...sample);
  const labels = ["M", "T", "W", "T", "F", "S", "S"];
  return (
    <>
      <Text style={styles.pageTitle}>{"Less scroll.\nMore day."}</Text>
      <Text style={styles.pageCopy}>
        Your Monday–Sunday screen-time week, kept on this device.
      </Text>
      <View style={styles.chartCard}>
        <View style={styles.chart}>
          {sample.map((value, index) => (
            <View key={`${labels[index]}-${index}`} style={styles.barGroup}>
              <View
                style={[
                  styles.bar,
                  {
                    height: `${value === 0 ? 0 : Math.min(Math.max(value / chartMax, 0.02), 1) * 100}%`,
                    backgroundColor: index === todayIndex ? ink : moss,
                  },
                ]}
              />
              <Text style={styles.barLabel}>{labels[index]}</Text>
            </View>
          ))}
        </View>
        <View
          style={[
            styles.targetLine,
            { top: 20 + (1 - Math.min(targetSeconds / chartMax, 1)) * 195 },
          ]}
        >
          <Text style={styles.targetText}>
            TARGET · {formatMinutes(targetSeconds)}
          </Text>
        </View>
      </View>
      <Pressable onPress={onRefresh}>
        <Text style={[styles.link, { alignSelf: "flex-end", marginTop: 12 }]}>
          Refresh week
        </Text>
      </Pressable>
      <View style={styles.statGrid}>
        <Stat label="TODAY" value={formatMinutes(usageSeconds)} />
        <Stat label="DAILY TARGET" value={formatMinutes(targetSeconds)} />
        <Stat label="YOUR INTENTION" value="Make space" />
      </View>
    </>
  );
}

function Reflect({
  journal,
  history,
  isWriting,
  onWriting,
  onChange,
}: {
  journal: JournalRecord;
  history: JournalRecord[];
  isWriting: boolean;
  onWriting: (value: boolean) => void;
  onChange: (next: JournalRecord) => void;
}) {
  const chars = journal.text.trim().length;
  const tasks = journalTaskCount(journal);
  return (
    <>
      <Text style={styles.pageTitle}>Close the day well.</Text>
      <Text style={styles.pageCopy}>
        Write a little about today, then make tomorrow easier to begin.
      </Text>
      <View style={styles.reflectStatus}>
        <ReflectionMilestone
          icon="create-outline"
          label="REFLECT"
          value={`${chars}/300`}
          complete={chars >= 300}
        />
        <ReflectionMilestone
          icon="time-outline"
          label="STAY"
          value={`${Math.min(journal.activeSeconds, 120)}s / 120s`}
          complete={journal.activeSeconds >= 120}
        />
        <ReflectionMilestone
          icon="checkmark-outline"
          label="PLAN"
          value={`${tasks}/3`}
          complete={tasks >= 3}
        />
      </View>
      <Text style={styles.eyebrow}>TODAY’S REFLECTION</Text>
      <View style={styles.journalEditor}>
        <TextInput
          multiline
          value={journal.text}
          onFocus={() => onWriting(true)}
          onBlur={() => onWriting(false)}
          onChangeText={(text) => onChange({ ...journal, text })}
          placeholder="What made today feel real? What do you want to remember?"
          placeholderTextColor="#9F978A"
          style={styles.journalInput}
          textAlignVertical="top"
        />
        <Text style={styles.editorFooter}>
          {isWriting ? "Writing time is counting" : "Tap to write"} · {chars}{" "}
          characters
        </Text>
      </View>
      <Text style={styles.eyebrow}>TOMORROW’S WORK</Text>
      <TaskGroup
        title="MUST DO"
        hint="The few things that matter most"
        tasks={journal.plan.must}
        onChange={(must) =>
          onChange({ ...journal, plan: { ...journal.plan, must } })
        }
      />
      <TaskGroup
        title="SHOULD DO"
        hint="Helpful if the day allows"
        tasks={journal.plan.should}
        onChange={(should) =>
          onChange({ ...journal, plan: { ...journal.plan, should } })
        }
      />
      <TaskGroup
        title="IF THERE’S TIME"
        hint="Nice-to-have, no pressure"
        tasks={journal.plan.ifTime}
        onChange={(ifTime) =>
          onChange({ ...journal, plan: { ...journal.plan, ifTime } })
        }
      />
      <Text style={styles.eyebrow}>PAST DAYS</Text>
      {history.length === 0 ? (
        <Text style={styles.small}>
          Your reflections will collect here, newest first.
        </Text>
      ) : (
        history.map((entry) => (
          <View key={entry.dayStart} style={styles.historyCard}>
            <Text style={styles.historyDate}>
              {new Date(entry.dayStart).toLocaleDateString(undefined, {
                weekday: "long",
                month: "short",
                day: "numeric",
              })}
            </Text>
            <Text style={styles.historyExcerpt} numberOfLines={2}>
              {entry.text || "No reflection written."}
            </Text>
            <Text style={styles.small}>
              {entry.text.trim().length} characters · {journalTaskCount(entry)}{" "}
              tomorrow tasks
            </Text>
          </View>
        ))
      )}
    </>
  );
}

function TaskGroup({
  title,
  hint,
  tasks,
  onChange,
}: {
  title: string;
  hint: string;
  tasks: string[];
  onChange: (tasks: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const task = draft.trim();
    if (!task) return;
    onChange([...tasks, task]);
    setDraft("");
  };
  return (
    <View style={styles.taskGroup}>
      <Text style={styles.taskTitle}>{title}</Text>
      <Text style={styles.taskHint}>{hint}</Text>
      {tasks.map((task, index) => (
        <Animated.View
          key={`${task}-${index}`}
          entering={FadeInDown.duration(180).easing(Easing.out(Easing.cubic))}
          exiting={FadeOutUp.duration(120)}
          style={styles.taskRow}
        >
          <Ionicons name="ellipse-outline" size={16} color={moss} />
          <Text style={styles.taskText}>{task}</Text>
          <Pressable
            onPress={() =>
              onChange(tasks.filter((_, itemIndex) => itemIndex !== index))
            }
          >
            <Ionicons name="close" size={18} color="#817A6E" />
          </Pressable>
        </Animated.View>
      ))}
      <View style={styles.taskAdd}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={add}
          placeholder="Add a task"
          placeholderTextColor="#9F978A"
          style={styles.taskInput}
          returnKeyType="done"
        />
        <Pressable onPress={add}>
          <Ionicons name="add-circle" size={24} color={ink} />
        </Pressable>
      </View>
    </View>
  );
}

function ReflectionMilestone({
  icon,
  label,
  value,
  complete,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
  complete: boolean;
}) {
  const scale = useSharedValue(1);
  const style = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  useEffect(() => {
    if (complete)
      scale.value = withSequence(
        withTiming(0.96, { duration: 80 }),
        withSpring(1, { damping: 14, stiffness: 280 }),
      );
  }, [complete, scale]);
  return (
    <Animated.View
      style={[styles.milestone, complete && styles.milestoneComplete, style]}
    >
      <Ionicons
        name={complete ? "checkmark-circle" : icon}
        size={17}
        color={complete ? "#FFFDF7" : moss}
      />
      <Text
        style={[
          styles.milestoneLabel,
          complete && styles.milestoneTextComplete,
        ]}
      >
        {label}
      </Text>
      <Text
        style={[
          styles.milestoneValue,
          complete && styles.milestoneTextComplete,
        ]}
      >
        {value}
      </Text>
    </Animated.View>
  );
}

function ClaimButton({
  onPress,
  disabled,
  label,
}: {
  onPress: () => void;
  disabled: boolean;
  label: string;
}) {
  const scale = useSharedValue(1);
  const style = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  return (
    <Animated.View
      entering={FadeInDown.duration(220).easing(Easing.out(Easing.cubic))}
      style={style}
    >
      <Pressable
        style={[styles.primaryButton, disabled && styles.disabled]}
        disabled={disabled}
        onPress={onPress}
        onPressIn={() => {
          scale.value = withTiming(0.98, { duration: 80 });
        }}
        onPressOut={() => {
          scale.value = withTiming(1, { duration: 120 });
        }}
      >
        <Text style={styles.primaryText}>{label}</Text>
      </Pressable>
    </Animated.View>
  );
}

function PlantingMoment({ visible }: { visible: boolean }) {
  const opacity = useSharedValue(0);
  const scale = useSharedValue(0.92);
  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));
  useEffect(() => {
    if (!visible) return;
    opacity.value = withTiming(1, { duration: 150 });
    scale.value = withSequence(
      withTiming(1.04, { duration: 260, easing: Easing.out(Easing.cubic) }),
      withSpring(1, { damping: 13, stiffness: 200 }),
    );
  }, [opacity, scale, visible]);
  if (!visible) return null;
  return (
    <View pointerEvents="none" style={styles.plantingOverlay}>
      <Animated.View style={[styles.plantingCard, style]}>
        <Image
          source={require("@/assets/images/grass.png")}
          style={styles.plantingGrass}
        />
        <Text style={styles.plantingTitle}>Your patch is planted.</Text>
        <Text style={styles.plantingCopy}>
          mUSDC is locked. MON paid only gas.
        </Text>
      </Animated.View>
    </View>
  );
}

function NavItem({
  active,
  icon,
  label,
  onPress,
}: {
  active: boolean;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.navItem} onPress={onPress}>
      <Ionicons name={icon} size={21} color={active ? ink : "#928A7D"} />
      <Text style={[styles.navText, active && styles.navTextActive]}>
        {label}
      </Text>
    </Pressable>
  );
}
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.monoLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: paper },
  loading: {
    flex: 1,
    backgroundColor: paper,
    alignItems: "center",
    justifyContent: "center",
  },
  topbar: {
    height: 68,
    paddingHorizontal: 22,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  wordmark: { flexDirection: "row", alignItems: "center", gap: 9 },
  headerGrass: { width: 31, height: 31, resizeMode: "contain" },
  logo: {
    fontFamily: Platform.select({ ios: "Bodoni 72", android: "serif" }),
    fontSize: 25,
    fontWeight: "700",
    color: ink,
    letterSpacing: -0.7,
  },
  walletPill: {
    borderWidth: 1,
    borderColor: line,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  mono: {
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
    color: ink,
    fontSize: 12,
  },
  scroll: { paddingHorizontal: 22, paddingTop: 15, paddingBottom: 108 },
  eyebrowRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  eyebrow: {
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
    color: "#777064",
    letterSpacing: 1.6,
    fontSize: 10,
    marginTop: 23,
    marginBottom: 10,
  },
  hero: {
    minHeight: 305,
    borderWidth: 1,
    borderColor: line,
    borderRadius: 26,
    overflow: "hidden",
    backgroundColor: "#DED8C9",
    padding: 22,
    justifyContent: "flex-end",
  },
  grass: {
    position: "absolute",
    width: "112%",
    height: 290,
    top: -35,
    right: -22,
    opacity: 0.74,
  },
  heroTitle: {
    fontFamily: Platform.select({ ios: "Bodoni 72", android: "serif" }),
    fontSize: 39,
    lineHeight: 38,
    fontWeight: "700",
    color: "#FFFDF5",
    letterSpacing: -1.2,
    textShadowColor: "rgba(0,0,0,0.35)",
    textShadowRadius: 8,
  },
  heroCopy: {
    color: "#FFFDF5",
    fontSize: 13,
    lineHeight: 19,
    maxWidth: 232,
    marginTop: 10,
    textShadowColor: "rgba(0,0,0,0.45)",
    textShadowRadius: 5,
  },
  timeCard: {
    marginTop: 16,
    borderRadius: 22,
    padding: 19,
    backgroundColor: "#FFFDF7",
    borderWidth: 1,
    borderColor: line,
  },
  monoLabel: {
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
    color: "#7A7367",
    letterSpacing: 1.2,
    fontSize: 10,
  },
  time: {
    color: ink,
    fontFamily: Platform.select({ ios: "Bodoni 72", android: "serif" }),
    fontSize: 48,
    lineHeight: 58,
    letterSpacing: -2,
    marginTop: 3,
  },
  track: {
    height: 7,
    borderRadius: 6,
    backgroundColor: "#E4DECF",
    marginTop: 12,
    overflow: "hidden",
  },
  fill: { height: "100%", borderRadius: 6 },
  fillAnimated: {
    position: "absolute",
    left: 0,
    top: 0,
    width: "100%",
    transformOrigin: "left",
  },
  timeFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginTop: 11,
  },
  small: { color: "#777064", fontSize: 12, lineHeight: 17, flexShrink: 1 },
  link: {
    color: ink,
    fontWeight: "700",
    fontSize: 12,
    textDecorationLine: "underline",
  },
  rule: { height: 1, backgroundColor: line, marginVertical: 23 },
  releaseRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  release: {
    color: ink,
    fontSize: 26,
    fontFamily: Platform.select({ ios: "Bodoni 72", android: "serif" }),
    fontWeight: "700",
    marginVertical: 2,
  },
  outlineButton: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: ink,
    borderRadius: 11,
  },
  outlineText: { color: ink, fontWeight: "700", fontSize: 13 },
  disclaimer: { color: "#9A9387", fontSize: 11, lineHeight: 16, marginTop: 26 },
  nav: {
    height: 78,
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "#FFFDF7",
    borderTopWidth: 1,
    borderColor: line,
    flexDirection: "row",
    justifyContent: "space-around",
    paddingTop: 13,
  },
  navItem: { minWidth: 48, alignItems: "center", gap: 3 },
  navText: { color: "#928A7D", fontSize: 9 },
  navTextActive: { color: ink, fontWeight: "700" },
  pageTitle: {
    color: ink,
    fontFamily: Platform.select({ ios: "Bodoni 72", android: "serif" }),
    fontWeight: "700",
    fontSize: 43,
    lineHeight: 44,
    letterSpacing: -1.5,
    marginTop: 8,
  },
  pageCopy: {
    color: "#716A5F",
    fontSize: 15,
    lineHeight: 22,
    marginTop: 12,
    maxWidth: 330,
  },
  segment: {
    flexDirection: "row",
    borderWidth: 1,
    borderColor: line,
    borderRadius: 14,
    overflow: "hidden",
    backgroundColor: "#FFFDF7",
  },
  segmentOption: { flex: 1, paddingVertical: 13, alignItems: "center" },
  segmentActive: { backgroundColor: ink },
  disabled: { opacity: 0.5 },
  segmentText: { color: ink, fontWeight: "600", fontSize: 13 },
  segmentTextActive: { color: "#FFFDF7" },
  stepper: {
    backgroundColor: "#FFFDF7",
    borderColor: line,
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 21,
    height: 70,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  stepperValue: {
    fontFamily: Platform.select({ ios: "Bodoni 72", android: "serif" }),
    color: ink,
    fontSize: 34,
    fontWeight: "700",
  },
  stepperUnit: {
    color: "#777064",
    fontSize: 15,
    fontFamily: "System",
    fontWeight: "400",
  },
  inputShell: {
    minHeight: 57,
    backgroundColor: "#FFFDF7",
    borderColor: line,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  input: { flex: 1, color: ink, fontSize: 16, paddingVertical: 13 },
  totalCard: {
    marginTop: 20,
    backgroundColor: softMoss,
    padding: 18,
    borderRadius: 18,
  },
  total: {
    color: ink,
    fontFamily: Platform.select({ ios: "Bodoni 72", android: "serif" }),
    fontWeight: "700",
    fontSize: 33,
    marginVertical: 4,
  },
  primaryButton: {
    backgroundColor: ink,
    borderRadius: 15,
    minHeight: 55,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 22,
  },
  primaryText: { color: "#FFFDF7", fontWeight: "700", fontSize: 16 },
  balanceCard: {
    backgroundColor: ink,
    borderRadius: 23,
    padding: 22,
    marginTop: 22,
  },
  balance: {
    color: "#FFFDF7",
    fontFamily: Platform.select({ ios: "Bodoni 72", android: "serif" }),
    fontSize: 43,
    fontWeight: "700",
    letterSpacing: -1.5,
    marginVertical: 5,
  },
  balanceUnit: {
    fontFamily: "System",
    fontSize: 16,
    fontWeight: "400",
    letterSpacing: 0,
  },
  notice: {
    backgroundColor: softMoss,
    padding: 16,
    borderRadius: 14,
    flexDirection: "row",
    gap: 10,
    marginTop: 21,
  },
  noticeText: { color: "#435539", fontSize: 12, lineHeight: 17, flex: 1 },
  outlineFullButton: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 54,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: ink,
    marginTop: 17,
  },
  chartCard: {
    height: 280,
    backgroundColor: "#FFFDF7",
    borderRadius: 22,
    borderWidth: 1,
    borderColor: line,
    marginTop: 24,
    padding: 20,
    justifyContent: "flex-end",
  },
  chart: {
    height: 195,
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: 8,
  },
  barGroup: {
    flex: 1,
    height: "100%",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 8,
  },
  bar: { width: "100%", maxWidth: 20, borderRadius: 12 },
  barLabel: {
    color: "#80796D",
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
    fontSize: 10,
  },
  targetLine: {
    position: "absolute",
    left: 20,
    right: 20,
    borderTopWidth: 1,
    borderColor: "#AA9E89",
    borderStyle: "dashed",
  },
  targetText: {
    backgroundColor: "#FFFDF7",
    alignSelf: "flex-end",
    marginTop: -8,
    color: "#8A8173",
    fontSize: 9,
    paddingLeft: 5,
  },
  statGrid: { flexDirection: "row", gap: 8, marginTop: 12 },
  reflectStatus: { flexDirection: "row", gap: 8, marginTop: 22 },
  stat: { flex: 1, padding: 12, borderRadius: 14, backgroundColor: "#EAE4D8" },
  statValue: {
    color: ink,
    fontFamily: Platform.select({ ios: "Bodoni 72", android: "serif" }),
    fontWeight: "700",
    fontSize: 18,
    marginTop: 6,
  },
  milestone: {
    flex: 1,
    minHeight: 78,
    padding: 11,
    borderRadius: 14,
    backgroundColor: "#EAE4D8",
  },
  milestoneComplete: { backgroundColor: moss },
  milestoneLabel: {
    color: "#7A7367",
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
    letterSpacing: 0.8,
    fontSize: 9,
    marginTop: 5,
  },
  milestoneValue: {
    color: ink,
    fontFamily: Platform.select({ ios: "Bodoni 72", android: "serif" }),
    fontWeight: "700",
    fontSize: 17,
    marginTop: 5,
  },
  milestoneTextComplete: { color: "#FFFDF7" },
  journalEditor: {
    minHeight: 230,
    borderColor: line,
    borderWidth: 1,
    borderRadius: 18,
    backgroundColor: "#FFFDF7",
    padding: 15,
  },
  journalInput: { color: ink, fontSize: 16, lineHeight: 24, minHeight: 165 },
  editorFooter: {
    color: "#817A6E",
    fontSize: 11,
    borderTopColor: line,
    borderTopWidth: 1,
    paddingTop: 10,
  },
  taskGroup: {
    backgroundColor: "#FFFDF7",
    borderColor: line,
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    marginBottom: 10,
  },
  taskTitle: {
    color: ink,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
    fontSize: 11,
    letterSpacing: 1.1,
  },
  taskHint: { color: "#817A6E", fontSize: 11, marginTop: 4, marginBottom: 9 },
  taskRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingVertical: 7,
  },
  taskText: { color: ink, fontSize: 14, flex: 1 },
  taskAdd: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderTopColor: line,
    borderTopWidth: 1,
    paddingTop: 8,
    marginTop: 3,
  },
  taskInput: { color: ink, fontSize: 14, flex: 1, paddingVertical: 7 },
  historyCard: { borderTopWidth: 1, borderColor: line, paddingVertical: 14 },
  historyDate: { color: ink, fontWeight: "700", fontSize: 13 },
  historyExcerpt: {
    color: "#514B41",
    fontSize: 13,
    lineHeight: 18,
    marginVertical: 5,
  },
  journalLocked: {
    marginTop: 22,
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
    padding: 17,
    borderWidth: 1,
    borderColor: line,
    borderStyle: "dashed",
    borderRadius: 16,
  },
  journalTitle: {
    color: ink,
    fontWeight: "700",
    fontSize: 14,
    marginBottom: 2,
  },
  plantingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(23,20,14,0.30)",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10,
  },
  plantingCard: {
    width: "76%",
    backgroundColor: "#FFFDF7",
    borderRadius: 24,
    alignItems: "center",
    padding: 24,
    borderWidth: 1,
    borderColor: line,
  },
  plantingGrass: { width: 134, height: 92, resizeMode: "contain" },
  plantingTitle: {
    color: ink,
    fontFamily: Platform.select({ ios: "Bodoni 72", android: "serif" }),
    fontWeight: "700",
    fontSize: 29,
    marginTop: 4,
  },
  plantingCopy: { color: "#716A5F", fontSize: 13, marginTop: 7 },
});
