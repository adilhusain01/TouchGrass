import AsyncStorage from "@react-native-async-storage/async-storage";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useState } from "react";
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
import { getContract, prepareContractCall, toUnits } from "thirdweb";

import { chain, getClient, mockUsdcAddress, vaultAddress, verifierUrl } from "@/constants/thirdweb";

type Tab = "today" | "setup" | "vault" | "insights";
type ProgramSettings = {
  duration: 7 | 14 | 28;
  targetHours: number;
  dailyUsdc: string;
  programId: string;
  startAt?: number;
};

const SETTINGS_KEY = "touchgrass.settings.v1";
const INSTALLATION_KEY = "touchgrass.installation-id.v1";
const ink = "#17140E";
const paper = "#F4EEDF";
const line = "#D4CCBC";
const moss = "#56734B";
const softMoss = "#E5EAD8";
const client = getClient();
const defaultSettings: ProgramSettings = { duration: 14, targetHours: 3, dailyUsdc: "1", programId: "" };

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

async function readTodayUsage(): Promise<number | null> {
  return readUsageFor(dateStart(), Date.now());
}

async function readUsageFor(startTime: number, endTime: number): Promise<number | null> {
  if (Platform.OS !== "android") return null;
  // The package only exists in Android development builds, never in Expo Go.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const module = require("@antardev/react-native-usage-stats");
  const usageStats = module.default ?? module;
  if (!usageStats.isPermissionGranted()) return null;
  const events = await usageStats.queryEvents({ startTime, endTime }) as {
    eventType: number;
    packageName: string;
    timeStamp: number;
  }[];
  if (events.length === 0) return null;

  const eventType = module.UsageEventType;
  const screenSegments: [number, number][] = [];
  const touchGrassSegments: [number, number][] = [];
  let interactive = false;
  let unlocked = false;
  let screenStartedAt: number | null = null;
  let touchGrassStartedAt: number | null = null;

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
    else if (event.eventType === eventType.SCREEN_NON_INTERACTIVE) interactive = false;
    else if (event.eventType === eventType.KEYGUARD_HIDDEN) unlocked = true;
    else if (event.eventType === eventType.KEYGUARD_SHOWN) unlocked = false;
    else if (event.packageName === "com.adilhusain.touchgrass") {
      if (event.eventType === eventType.ACTIVITY_RESUMED) touchGrassStartedAt = time;
      if ((event.eventType === eventType.ACTIVITY_PAUSED || event.eventType === eventType.ACTIVITY_STOPPED) && touchGrassStartedAt !== null) {
        touchGrassSegments.push([touchGrassStartedAt, time]);
        touchGrassStartedAt = null;
      }
    }
    updateScreenSegment(time);
  }
  updateScreenSegment(endTime);
  if (touchGrassStartedAt !== null) touchGrassSegments.push([touchGrassStartedAt, endTime]);

  const screenMs = screenSegments.reduce((total, [start, end]) => total + end - start, 0);
  const touchGrassMs = touchGrassSegments.reduce((total, [appStart, appEnd]) => total + screenSegments.reduce((overlap, [screenStart, screenEnd]) => overlap + Math.max(0, Math.min(appEnd, screenEnd) - Math.max(appStart, screenStart)), 0), 0);
  return Math.round(Math.max(0, screenMs - touchGrassMs) / 1_000);
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
  const [hasUsageAccess, setHasUsageAccess] = useState(false);
  const [settings, setSettings] = useState<ProgramSettings>(defaultSettings);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isCheckingIn, setIsCheckingIn] = useState(false);

  const { data: balance, refetch: refetchBalance } = useWalletBalance({
    client,
    address: account?.address,
    chain,
  });

  useEffect(() => {
    AsyncStorage.getItem(SETTINGS_KEY).then((stored) => {
      if (stored) setSettings({ ...defaultSettings, ...JSON.parse(stored) });
      setIsLoaded(true);
    }).catch(() => setIsLoaded(true));
  }, []);

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
    const values = await Promise.all(Array.from({ length: 7 }, async (_, index) => {
      const start = todayStart - (6 - index) * 86_400_000;
      const end = index === 6 ? Date.now() : start + 86_400_000;
      return (await readUsageFor(start, end)) ?? 0;
    }));
    setWeekUsage(values);
  }, []);

  useEffect(() => { void refreshUsage(); }, [refreshUsage]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshUsage();
    });
    return () => subscription.remove();
  }, [refreshUsage]);
  useEffect(() => {
    if (tab === "insights" && hasUsageAccess) void refreshWeekUsage();
  }, [hasUsageAccess, refreshWeekUsage, tab]);

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
    if (Platform.OS !== "android") return Alert.alert("Android first", "TouchGrass needs Android Usage Access for this MVP.");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const module = require("@antardev/react-native-usage-stats");
    const usageStats = module.default ?? module;
    usageStats.requestPermission();
  };

  const createProgram = () => {
    if (!account) return Alert.alert("Connect your wallet", "Create an embedded wallet first.");
    if (!vaultAddress || !mockUsdcAddress) return Alert.alert("Contracts not configured", "Add the vault and mUSDC addresses to your app environment.");
    const amount = Number(settings.dailyUsdc);
    if (!Number.isFinite(amount) || amount <= 0) return Alert.alert("Set a daily amount", "Use a positive mUSDC allowance.");
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
      method: "function createProgram(uint16 durationDays,uint32 dailyLimitSeconds,uint96 dailyAmount,address beneficiary,uint64 startAt) returns (uint256)",
      params: [settings.duration, Math.round(settings.targetHours * 3_600), dailyAmount, account.address, BigInt(startAt)],
    });
    // thirdweb's React Native hook defaults to an ABI-less contract type;
    // the prepared transaction contains the concrete ABI method at runtime.
    sendTransaction(approve as never, {
      onSuccess: () => {
        sendTransaction(create as never, {
          onSuccess: () => {
            void saveSettings({ ...settings, startAt });
            void refetchBalance();
            Alert.alert("Your patch is planted", "Your mUSDC is locked; MON only paid the two transaction fees. Save the Program ID from the contract event in the Vault tab.");
            setTab("vault");
          },
          onError: (error) => Alert.alert("Approval complete, vault failed", error.message),
        });
      },
      onError: (error) => Alert.alert("Could not approve mUSDC", error.message),
    });
  };

  const mintMockUsdc = () => {
    if (!mockUsdcAddress) return Alert.alert("mUSDC not configured", "Add EXPO_PUBLIC_MOCK_USDC_ADDRESS after deployment.");
    const usdc = getContract({ client, chain, address: mockUsdcAddress });
    const transaction = prepareContractCall({ contract: usdc, method: "function mint()" });
    sendTransaction(transaction as never, {
      onSuccess: () => Alert.alert("1,000 mUSDC minted", "This is a test token for your TouchGrass budget."),
      onError: (error) => Alert.alert(
        /insufficient balance/i.test(error.message) ? "Your TouchGrass wallet needs MON" : "Could not mint mUSDC",
        /insufficient balance/i.test(error.message) ? "Send a little Monad testnet MON to this embedded wallet. mUSDC is free; MON only pays the transaction fee." : error.message,
      ),
    });
  };

  const withdrawSavings = () => {
    if (!account || !vaultAddress || !settings.programId) return Alert.alert("Program ID needed", "Enter your program ID in the Vault tab first.");
    const contract = getContract({ client, chain, address: vaultAddress });
    const transaction = prepareContractCall({
      contract,
      method: "function withdrawMaturedSavings(uint256 programId)",
      params: [BigInt(settings.programId)],
    });
    sendTransaction(transaction as never, {
      onSuccess: () => { void refetchBalance(); Alert.alert("Savings released", "Your matured locked mUSDC returned to your wallet."); },
      onError: (error) => Alert.alert("Savings still locked", error.message),
    });
  };

  const checkInYesterday = async () => {
    if (!account || !vaultAddress || !verifierUrl || !settings.programId || !settings.startAt) {
      return Alert.alert("Finish your setup", "Connect a wallet, deploy the vault, add its Program ID, and set the verifier URL first.");
    }
    if (!hasUsageAccess) return requestUsageAccess();
    setIsCheckingIn(true);
    try {
      const deviceId = await installationId();
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const registrationMessage = `TouchGrass program registration\nprogram: ${settings.programId}\nwallet: ${account.address.toLowerCase()}\ntimezone: ${timezone}\ndevice: ${deviceId}`;
      const registrationSignature = await account.signMessage({ message: registrationMessage });
      const registration = await fetch(`${verifierUrl.replace(/\/$/, "")}/v1/programs/register`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ programId: settings.programId, wallet: account.address, timezone, installationId: deviceId, walletSignature: registrationSignature }),
      });
      if (!registration.ok) throw new Error((await registration.json().catch(() => ({}))).error ?? "Could not register the program");

      const periodEnd = dateStart();
      const periodStart = periodEnd - 86_400_000;
      const dayIndex = Math.floor((periodStart - settings.startAt * 1_000) / 86_400_000);
      if (dayIndex < 0) throw new Error("Your first program day has not closed yet.");
      const yesterday = await readUsageFor(periodStart, periodEnd);
      if (yesterday === null) throw new Error("Usage Access is not available.");
      const message = `TouchGrass daily check-in\nprogram: ${settings.programId}\nwallet: ${account.address.toLowerCase()}\nday: ${dayIndex}\nusageSeconds: ${yesterday}\nperiodStart: ${periodStart}\nperiodEnd: ${periodEnd}\ndevice: ${deviceId}`;
      const walletSignature = await account.signMessage({ message });
      const response = await fetch(`${verifierUrl.replace(/\/$/, "")}/v1/verify-day`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ programId: settings.programId, wallet: account.address, dayIndex, usageSeconds: yesterday, periodStart, periodEnd, installationId: deviceId, walletSignature }),
      });
      const result = await response.json() as { eligible?: boolean; reason?: string; error?: string; voucher?: { dayIndex: number; validUntil: number; signature: `0x${string}` } };
      if (!response.ok) throw new Error(result.error ?? "Verification failed");
      if (!result.eligible || !result.voucher) return Alert.alert("Allowance held", result.reason ?? "Your allowance stays in savings today.");

      const contract = getContract({ client, chain, address: vaultAddress });
      const transaction = prepareContractCall({
        contract,
        method: "function claim(uint256 programId,uint16 dayIndex,uint64 validUntil,bytes signature)",
        params: [BigInt(settings.programId), result.voucher.dayIndex, BigInt(result.voucher.validUntil), result.voucher.signature],
      });
      sendTransaction(transaction as never, {
        onSuccess: () => { void refetchBalance(); Alert.alert("mUSDC released", "Your successful day is now recorded on Monad."); },
        onError: (error) => Alert.alert("Voucher received, claim failed", error.message),
      });
    } catch (error) {
      Alert.alert("Check-in unavailable", error instanceof Error ? error.message : "Please try again when you are online.");
    } finally {
      setIsCheckingIn(false);
    }
  };

  const allowedSeconds = settings.targetHours * 3_600;
  const progress = Math.min((usageSeconds ?? 0) / allowedSeconds, 1);
  const remainingSeconds = Math.max(allowedSeconds - (usageSeconds ?? 0), 0);

  if (!isLoaded) return <View style={styles.loading}><Text style={styles.logo}>TouchGrass</Text></View>;

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.topbar}>
        <View style={styles.wordmark}><Image source={require("@/assets/images/grass.png")} style={styles.headerGrass} /><Text style={styles.logo}>TouchGrass</Text></View>
        {account ? <Pressable style={styles.walletPill} onPress={copyWalletAddress}><Text style={styles.mono}>{truncate(account.address)}</Text><Ionicons name="copy-outline" size={13} color={ink} /></Pressable> : <ConnectButton client={client} chain={chain} wallets={[inAppWallet({ auth: { options: ["email"] } })]} connectButton={{ label: "Create wallet" }} />}
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {tab === "today" && <Today usageSeconds={usageSeconds} hasUsageAccess={hasUsageAccess} progress={progress} remainingSeconds={remainingSeconds} settings={settings} onRefresh={refreshUsage} onRequestAccess={requestUsageAccess} onSetup={() => setTab("setup")} onCheckIn={checkInYesterday} checkingIn={isCheckingIn} />}
        {tab === "setup" && <Setup settings={settings} onChange={(next) => void saveSettings(next)} onCreate={createProgram} onMint={mintMockUsdc} pending={isPending} />}
        {tab === "vault" && <Vault balance={balance?.displayValue} settings={settings} onChange={(next) => void saveSettings(next)} onWithdraw={withdrawSavings} pending={isPending} />}
        {tab === "insights" && <Insights usageSeconds={usageSeconds ?? 0} targetSeconds={allowedSeconds} weekUsage={weekUsage} />}
      </ScrollView>

      <View style={styles.nav}>
        <NavItem active={tab === "today"} icon="sunny-outline" label="Today" onPress={() => setTab("today")} />
        <NavItem active={tab === "setup"} icon="leaf-outline" label="Plan" onPress={() => setTab("setup")} />
        <NavItem active={tab === "vault"} icon="lock-closed-outline" label="Vault" onPress={() => setTab("vault")} />
        <NavItem active={tab === "insights"} icon="pulse-outline" label="Insights" onPress={() => setTab("insights")} />
      </View>
    </SafeAreaView>
  );
}

function Today({ usageSeconds, hasUsageAccess, progress, remainingSeconds, settings, onRefresh, onRequestAccess, onSetup, onCheckIn, checkingIn }: { usageSeconds: number | null; hasUsageAccess: boolean; progress: number; remainingSeconds: number; settings: ProgramSettings; onRefresh: () => void; onRequestAccess: () => void; onSetup: () => void; onCheckIn: () => void; checkingIn: boolean }) {
  const hasUsageData = usageSeconds !== null;
  const aboveTarget = hasUsageData && progress >= 1;
  return <>
    <View style={styles.eyebrowRow}><Text style={styles.eyebrow}>TODAY’S PATCH</Text><Text style={styles.mono}>{new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" }).toUpperCase()}</Text></View>
    <View style={styles.hero}>
      <Image source={require("@/assets/images/grass.png")} style={styles.grass} resizeMode="contain" />
      <Text style={styles.heroTitle}>{aboveTarget ? "Come back\ntomorrow." : "Keep your day\nwide open."}</Text>
      <Text style={styles.heroCopy}>{aboveTarget ? "Today’s allowance is safe in savings." : "A small mUSDC allowance unlocks when your day closes under target."}</Text>
    </View>
    <View style={styles.timeCard}>
      <Text style={styles.monoLabel}>{hasUsageAccess ? "TRACKED SCREEN TIME" : "USAGE ACCESS NEEDED"}</Text>
      <Text style={styles.time}>{hasUsageAccess ? (hasUsageData ? formatMinutes(usageSeconds) : "Syncing…") : "—"}</Text>
      <View style={styles.track}><View style={[styles.fill, { width: `${Math.max(progress * 100, 2)}%`, backgroundColor: aboveTarget ? "#9A6049" : moss }]} /></View>
      <View style={styles.timeFooter}><Text style={styles.small}>{hasUsageAccess ? (hasUsageData ? `${formatMinutes(remainingSeconds)} left before your ${settings.targetHours}h limit` : "Reading Android screen time…") : "Give TouchGrass permission to read Android app-use time."}</Text><Pressable onPress={hasUsageAccess ? onRefresh : onRequestAccess}><Text style={styles.link}>{hasUsageAccess ? "Refresh" : "Allow"}</Text></Pressable></View>
      {hasUsageAccess && <Text style={[styles.small, { marginTop: 8 }]}>Interactive, unlocked screen time; TouchGrass itself is excluded.</Text>}
    </View>
    <View style={styles.rule} />
    <View style={styles.releaseRow}><View><Text style={styles.eyebrow}>NEXT DAILY RELEASE</Text><Text style={styles.release}>{settings.dailyUsdc} mUSDC</Text><Text style={styles.small}>Locked until your day closes</Text></View><Pressable style={styles.outlineButton} onPress={onSetup}><Text style={styles.outlineText}>Edit plan</Text></Pressable></View>
    <Pressable style={styles.primaryButton} onPress={onCheckIn} disabled={checkingIn}><Text style={styles.primaryText}>{checkingIn ? "Checking yesterday…" : "Check in yesterday"}</Text></Pressable>
    <Text style={styles.disclaimer}>TouchGrass is a voluntary commitment tool. Your app-use total stays on your device; only an aggregate result is sent when you check in.</Text>
  </>;
}

function Setup({ settings, onChange, onCreate, onMint, pending }: { settings: ProgramSettings; onChange: (next: ProgramSettings) => void; onCreate: () => void; onMint: () => void; pending: boolean }) {
  return <>
    <Text style={styles.pageTitle}>Plant a limit.</Text><Text style={styles.pageCopy}>Lock a small budget. Make it available only on days you made space for the real world.</Text>
    <Text style={styles.eyebrow}>PROGRAM LENGTH</Text><View style={styles.segment}>{([7, 14, 28] as const).map((days) => <Pressable key={days} style={[styles.segmentOption, settings.duration === days && styles.segmentActive]} onPress={() => onChange({ ...settings, duration: days })}><Text style={[styles.segmentText, settings.duration === days && styles.segmentTextActive]}>{days} days</Text></Pressable>)}</View>
    <Text style={styles.eyebrow}>DAILY APP-USE LIMIT</Text><View style={styles.stepper}><Pressable onPress={() => onChange({ ...settings, targetHours: Math.max(1, settings.targetHours - 1) })}><Ionicons name="remove" size={21} color={ink} /></Pressable><Text style={styles.stepperValue}>{settings.targetHours}<Text style={styles.stepperUnit}> hours</Text></Text><Pressable onPress={() => onChange({ ...settings, targetHours: Math.min(8, settings.targetHours + 1) })}><Ionicons name="add" size={21} color={ink} /></Pressable></View>
    <Text style={styles.eyebrow}>DAILY mUSDC RELEASE</Text><View style={styles.inputShell}><TextInput style={styles.input} value={settings.dailyUsdc} onChangeText={(dailyUsdc) => onChange({ ...settings, dailyUsdc })} keyboardType="decimal-pad" /><Text style={styles.mono}>mUSDC</Text></View>
    <View style={styles.totalCard}><Text style={styles.small}>YOU’LL LOCK</Text><Text style={styles.total}>{(Number(settings.dailyUsdc || 0) * settings.duration).toFixed(2)} mUSDC</Text><Text style={styles.small}>Unused daily releases return after a 7-day cooldown. MON pays only gas.</Text></View>
    <Pressable style={styles.outlineFullButton} onPress={onMint} disabled={pending}><Text style={styles.outlineText}>Mint 1,000 demo mUSDC</Text></Pressable>
    <Pressable style={styles.primaryButton} onPress={onCreate} disabled={pending}><Text style={styles.primaryText}>{pending ? "Planting your patch…" : "Lock this plan"}</Text></Pressable>
  </>;
}

function Vault({ balance, settings, onChange, onWithdraw, pending }: { balance?: string; settings: ProgramSettings; onChange: (next: ProgramSettings) => void; onWithdraw: () => void; pending: boolean }) {
  return <>
    <Text style={styles.pageTitle}>Your vault.</Text><Text style={styles.pageCopy}>The contract holds only what you choose to lock. TouchGrass cannot see or move other wallet funds.</Text>
    <View style={styles.balanceCard}><Text style={styles.monoLabel}>MON GAS BALANCE</Text><Text style={styles.balance}>{balance ?? "—"}<Text style={styles.balanceUnit}> MON</Text></Text><Text style={styles.small}>Your locked allowance is mUSDC · Monad Testnet</Text></View>
    <Text style={styles.eyebrow}>PROGRAM ID</Text><View style={styles.inputShell}><TextInput style={styles.input} value={settings.programId} onChangeText={(programId) => onChange({ ...settings, programId: programId.replace(/\D/g, "") })} placeholder="From ProgramCreated event" placeholderTextColor="#9F978A" keyboardType="number-pad" /><Ionicons name="receipt-outline" size={20} color={ink} /></View>
    <View style={styles.notice}><Ionicons name="information-circle-outline" size={19} color={moss} /><Text style={styles.noticeText}>After your program and its 7-day cooldown finish, any unreleased mUSDC can return to your wallet. MON is never locked.</Text></View>
    <Pressable style={styles.outlineFullButton} onPress={onWithdraw} disabled={pending}><Text style={styles.outlineText}>{pending ? "Checking vault…" : "Withdraw matured savings"}</Text></Pressable>
    <Pressable onPress={() => Linking.openURL("https://faucet.monad.xyz")}><Text style={[styles.link, { marginTop: 22, textAlign: "center" }]}>Get testnet MON ↗</Text></Pressable>
  </>;
}

function Insights({ usageSeconds, targetSeconds, weekUsage }: { usageSeconds: number; targetSeconds: number; weekUsage: number[] }) {
  const sample = [...Array(6).fill(0), usageSeconds].map((fallback, index) => weekUsage[index] ?? fallback);
  const chartMax = Math.max(6 * 3_600, ...sample);
  const labels = ["M", "T", "W", "T", "F", "S", "S"];
  return <>
    <Text style={styles.pageTitle}>{"Less scroll.\nMore day."}</Text><Text style={styles.pageCopy}>Your seven-day picture lives only on this device.</Text>
    <View style={styles.chartCard}><View style={styles.chart}>{sample.map((value, index) => <View key={`${labels[index]}-${index}`} style={styles.barGroup}><View style={[styles.bar, { height: `${Math.min(Math.max(value / chartMax, 0.02), 1) * 100}%`, backgroundColor: index === 6 ? ink : moss }]} /><Text style={styles.barLabel}>{labels[index]}</Text></View>)}</View><View style={[styles.targetLine, { top: 20 + (1 - Math.min(targetSeconds / chartMax, 1)) * 195 }]}><Text style={styles.targetText}>TARGET · {formatMinutes(targetSeconds)}</Text></View></View>
    <View style={styles.statGrid}><Stat label="TODAY" value={formatMinutes(usageSeconds)} /><Stat label="DAILY TARGET" value={formatMinutes(targetSeconds)} /><Stat label="YOUR INTENTION" value="Make space" /></View>
    <View style={styles.journalLocked}><Ionicons name="lock-closed-outline" size={20} color={ink} /><View><Text style={styles.journalTitle}>Journal, later</Text><Text style={styles.small}>A quiet reflection space is growing in the next milestone.</Text></View></View>
  </>;
}

function NavItem({ active, icon, label, onPress }: { active: boolean; icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }) { return <Pressable style={styles.navItem} onPress={onPress}><Ionicons name={icon} size={21} color={active ? ink : "#928A7D"} /><Text style={[styles.navText, active && styles.navTextActive]}>{label}</Text></Pressable>; }
function Stat({ label, value }: { label: string; value: string }) { return <View style={styles.stat}><Text style={styles.monoLabel}>{label}</Text><Text style={styles.statValue}>{value}</Text></View>; }

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: paper }, loading: { flex: 1, backgroundColor: paper, alignItems: "center", justifyContent: "center" }, topbar: { height: 68, paddingHorizontal: 22, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, wordmark: { flexDirection: "row", alignItems: "center", gap: 9 }, headerGrass: { width: 31, height: 31, resizeMode: "contain" }, logo: { fontFamily: Platform.select({ ios: "Bodoni 72", android: "serif" }), fontSize: 25, fontWeight: "700", color: ink, letterSpacing: -0.7 }, walletPill: { borderWidth: 1, borderColor: line, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 18, flexDirection: "row", alignItems: "center", gap: 6 }, mono: { fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }), color: ink, fontSize: 12 }, scroll: { paddingHorizontal: 22, paddingTop: 15, paddingBottom: 108 }, eyebrowRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }, eyebrow: { fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }), color: "#777064", letterSpacing: 1.6, fontSize: 10, marginTop: 23, marginBottom: 10 }, hero: { minHeight: 305, borderWidth: 1, borderColor: line, borderRadius: 26, overflow: "hidden", backgroundColor: "#DED8C9", padding: 22, justifyContent: "flex-end" }, grass: { position: "absolute", width: "112%", height: 290, top: -35, right: -22, opacity: 0.74 }, heroTitle: { fontFamily: Platform.select({ ios: "Bodoni 72", android: "serif" }), fontSize: 39, lineHeight: 38, fontWeight: "700", color: "#FFFDF5", letterSpacing: -1.2, textShadowColor: "rgba(0,0,0,0.35)", textShadowRadius: 8 }, heroCopy: { color: "#FFFDF5", fontSize: 13, lineHeight: 19, maxWidth: 232, marginTop: 10, textShadowColor: "rgba(0,0,0,0.45)", textShadowRadius: 5 }, timeCard: { marginTop: 16, borderRadius: 22, padding: 19, backgroundColor: "#FFFDF7", borderWidth: 1, borderColor: line }, monoLabel: { fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }), color: "#7A7367", letterSpacing: 1.2, fontSize: 10 }, time: { color: ink, fontFamily: Platform.select({ ios: "Bodoni 72", android: "serif" }), fontSize: 48, lineHeight: 58, letterSpacing: -2, marginTop: 3 }, track: { height: 7, borderRadius: 6, backgroundColor: "#E4DECF", marginTop: 12, overflow: "hidden" }, fill: { height: "100%", borderRadius: 6 }, timeFooter: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 11 }, small: { color: "#777064", fontSize: 12, lineHeight: 17, flexShrink: 1 }, link: { color: ink, fontWeight: "700", fontSize: 12, textDecorationLine: "underline" }, rule: { height: 1, backgroundColor: line, marginVertical: 23 }, releaseRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, release: { color: ink, fontSize: 26, fontFamily: Platform.select({ ios: "Bodoni 72", android: "serif" }), fontWeight: "700", marginVertical: 2 }, outlineButton: { paddingVertical: 10, paddingHorizontal: 14, borderWidth: 1, borderColor: ink, borderRadius: 11 }, outlineText: { color: ink, fontWeight: "700", fontSize: 13 }, disclaimer: { color: "#9A9387", fontSize: 11, lineHeight: 16, marginTop: 26 }, nav: { height: 78, position: "absolute", bottom: 0, left: 0, right: 0, backgroundColor: "#FFFDF7", borderTopWidth: 1, borderColor: line, flexDirection: "row", justifyContent: "space-around", paddingTop: 13 }, navItem: { minWidth: 55, alignItems: "center", gap: 3 }, navText: { color: "#928A7D", fontSize: 10 }, navTextActive: { color: ink, fontWeight: "700" }, pageTitle: { color: ink, fontFamily: Platform.select({ ios: "Bodoni 72", android: "serif" }), fontWeight: "700", fontSize: 43, lineHeight: 44, letterSpacing: -1.5, marginTop: 8 }, pageCopy: { color: "#716A5F", fontSize: 15, lineHeight: 22, marginTop: 12, maxWidth: 330 }, segment: { flexDirection: "row", borderWidth: 1, borderColor: line, borderRadius: 14, overflow: "hidden", backgroundColor: "#FFFDF7" }, segmentOption: { flex: 1, paddingVertical: 13, alignItems: "center" }, segmentActive: { backgroundColor: ink }, segmentText: { color: ink, fontWeight: "600", fontSize: 13 }, segmentTextActive: { color: "#FFFDF7" }, stepper: { backgroundColor: "#FFFDF7", borderColor: line, borderWidth: 1, borderRadius: 16, paddingHorizontal: 21, height: 70, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, stepperValue: { fontFamily: Platform.select({ ios: "Bodoni 72", android: "serif" }), color: ink, fontSize: 34, fontWeight: "700" }, stepperUnit: { color: "#777064", fontSize: 15, fontFamily: "System", fontWeight: "400" }, inputShell: { minHeight: 57, backgroundColor: "#FFFDF7", borderColor: line, borderWidth: 1, borderRadius: 14, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, input: { flex: 1, color: ink, fontSize: 16, paddingVertical: 13 }, totalCard: { marginTop: 20, backgroundColor: softMoss, padding: 18, borderRadius: 18 }, total: { color: ink, fontFamily: Platform.select({ ios: "Bodoni 72", android: "serif" }), fontWeight: "700", fontSize: 33, marginVertical: 4 }, primaryButton: { backgroundColor: ink, borderRadius: 15, minHeight: 55, alignItems: "center", justifyContent: "center", marginTop: 22 }, primaryText: { color: "#FFFDF7", fontWeight: "700", fontSize: 16 }, balanceCard: { backgroundColor: ink, borderRadius: 23, padding: 22, marginTop: 22 }, balance: { color: "#FFFDF7", fontFamily: Platform.select({ ios: "Bodoni 72", android: "serif" }), fontSize: 43, fontWeight: "700", letterSpacing: -1.5, marginVertical: 5 }, balanceUnit: { fontFamily: "System", fontSize: 16, fontWeight: "400", letterSpacing: 0 }, notice: { backgroundColor: softMoss, padding: 16, borderRadius: 14, flexDirection: "row", gap: 10, marginTop: 21 }, noticeText: { color: "#435539", fontSize: 12, lineHeight: 17, flex: 1 }, outlineFullButton: { alignItems: "center", justifyContent: "center", minHeight: 54, borderRadius: 14, borderWidth: 1, borderColor: ink, marginTop: 17 }, chartCard: { height: 280, backgroundColor: "#FFFDF7", borderRadius: 22, borderWidth: 1, borderColor: line, marginTop: 24, padding: 20, justifyContent: "flex-end" }, chart: { height: 195, flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", gap: 8 }, barGroup: { flex: 1, height: "100%", alignItems: "center", justifyContent: "flex-end", gap: 8 }, bar: { width: "100%", maxWidth: 20, borderRadius: 12 }, barLabel: { color: "#80796D", fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }), fontSize: 10 }, targetLine: { position: "absolute", left: 20, right: 20, borderTopWidth: 1, borderColor: "#AA9E89", borderStyle: "dashed" }, targetText: { backgroundColor: "#FFFDF7", alignSelf: "flex-end", marginTop: -8, color: "#8A8173", fontSize: 9, paddingLeft: 5 }, statGrid: { flexDirection: "row", gap: 8, marginTop: 12 }, stat: { flex: 1, padding: 12, borderRadius: 14, backgroundColor: "#EAE4D8" }, statValue: { color: ink, fontFamily: Platform.select({ ios: "Bodoni 72", android: "serif" }), fontWeight: "700", fontSize: 18, marginTop: 6 }, journalLocked: { marginTop: 22, flexDirection: "row", gap: 12, alignItems: "center", padding: 17, borderWidth: 1, borderColor: line, borderStyle: "dashed", borderRadius: 16 }, journalTitle: { color: ink, fontWeight: "700", fontSize: 14, marginBottom: 2 },
});
