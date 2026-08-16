import {getDefaultConfig} from '@rainbow-me/rainbowkit';
import {defineChain} from 'viem';
import {mainnet, sepolia} from 'wagmi/chains';

/**
 * Local Anvil node from `docker compose up`.
 *
 * Included so the whole stack runs offline: no faucet, no RPC key, no waiting for testnet blocks.
 */
const anvil = defineChain({
  id: 31337,
  name: 'Anvil',
  nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
  // Configurable, because the portfolio runs several Anvils at once and they cannot all own 8545.
  rpcUrls: {default: {http: [process.env.NEXT_PUBLIC_RPC_URL || 'http://127.0.0.1:8545']}},
  testnet: true,
});

const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 11155111);

const chainsById = {
  [mainnet.id]: mainnet,
  [sepolia.id]: sepolia,
  [anvil.id]: anvil,
} as const;

const activeChain = chainsById[chainId as keyof typeof chainsById] ?? sepolia;

export const wagmiConfig = getDefaultConfig({
  appName: 'B1zt Token Suite',
  // WalletConnect requires a project id. Without one only injected wallets work, which is fine for
  // local development but breaks mobile wallets in a real deployment.
  // `??` is not enough here: an unset variable in a .env file arrives as an empty string, not as
  // undefined, and RainbowKit throws on an empty project id. That turned "I have not signed up for
  // WalletConnect yet" into a 500 on every page, which is the worst possible first run.
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || 'demo',
  chains: [activeChain],
  ssr: true,
});

export {activeChain};
