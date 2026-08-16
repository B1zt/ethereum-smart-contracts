import {createPublicClient, http, type PublicClient} from 'viem';
import {foundry, mainnet, sepolia} from 'viem/chains';
import {config} from '../config.js';

const supportedChains = {
  // Local Anvil. The project ships one in docker-compose, so leaving it out would mean the
  // documented zero-config setup could not actually start.
  [foundry.id]: foundry,
  [mainnet.id]: mainnet,
  [sepolia.id]: sepolia,
} as const;

function resolveChain() {
  const chain = supportedChains[config.CHAIN_ID as keyof typeof supportedChains];
  if (!chain) {
    throw new Error(
      `Unsupported CHAIN_ID ${config.CHAIN_ID}. Add the chain to supportedChains in chain/client.ts.`,
    );
  }
  return chain;
}

/**
 * Shared read-only chain client.
 *
 * `batch.multicall` lets viem coalesce concurrent `eth_call`s into a single multicall request.
 * Serving a dashboard issues many independent reads at once (balance, votes, vault position,
 * releasable vesting); batching turns that burst into a handful of round trips instead of
 * dozens, which matters a great deal against a rate-limited public RPC.
 */
export const publicClient: PublicClient = createPublicClient({
  chain: resolveChain(),
  transport: http(config.RPC_URL, {
    retryCount: 3,
    retryDelay: 250,
    timeout: 20_000,
  }),
  batch: {
    multicall: {wait: 16},
  },
});

/** Chain head, as a bigint. */
export async function getHeadBlock(): Promise<bigint> {
  return publicClient.getBlockNumber();
}

/**
 * Highest block considered final.
 *
 * Everything at or below this is safe to persist without a reorg check. The indexer re-scans the
 * gap between this and the head on every pass.
 */
export async function getSafeBlock(): Promise<bigint> {
  const head = await getHeadBlock();
  const confirmations = BigInt(config.CONFIRMATIONS);
  return head > confirmations ? head - confirmations : 0n;
}
