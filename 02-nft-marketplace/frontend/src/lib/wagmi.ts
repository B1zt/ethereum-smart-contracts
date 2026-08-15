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
  rpcUrls: {default: {http: ['http://127.0.0.1:8545']}},
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
  appName: 'B1zt NFT Marketplace',
  // WalletConnect requires a project id. Without one only injected wallets work, which is fine for
  // local development but breaks mobile wallets in a real deployment.
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? 'demo',
  chains: [activeChain],
  ssr: true,
});

export {activeChain};
