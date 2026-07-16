import { createThirdwebClient, defineChain } from "thirdweb";

export const chain = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpc: "https://monad-testnet.drpc.org",
  blockExplorers: [{ name: "MonadScan", url: "https://testnet.monadscan.com" }],
});

export const getClient = () =>
  createThirdwebClient({
    clientId: process.env.EXPO_PUBLIC_THIRDWEB_CLIENT_ID ?? "touchgrass-demo-client-id",
  });

export const vaultAddress = process.env.EXPO_PUBLIC_VAULT_ADDRESS as `0x${string}` | undefined;
export const verifierUrl = process.env.EXPO_PUBLIC_VERIFIER_URL;
