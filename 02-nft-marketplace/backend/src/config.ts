import 'dotenv/config';
import {z} from 'zod';

/**
 * Environment is validated once, at boot, and never read from `process.env` again.
 *
 * A misconfigured RPC URL or a missing contract address should crash the process on startup with a
 * clear message, not surface as a confusing runtime failure on the first request an hour later.
 */
const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte hex address')
  .transform((value) => value.toLowerCase() as `0x${string}`);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((value) => value.split(',').map((origin) => origin.trim())),

  DATABASE_URL: z.string().url(),

  CHAIN_ID: z.coerce.number().int().positive().default(11155111),
  RPC_URL: z.string().url(),

  MARKETPLACE_ADDRESS: addressSchema,
  AUCTION_ADDRESS: addressSchema,
  COLLECTION_ADDRESS: addressSchema,

  /**
   * How far behind the chain head a block must be before its logs are treated as final.
   *
   * Below this depth a reorg can still erase a log we have already written, so the indexer
   * re-scans this window on every pass instead of trusting it once.
   */
  CONFIRMATIONS: z.coerce.number().int().nonnegative().default(12),

  /** Blocks per `eth_getLogs` call. Most public RPCs reject ranges much wider than this. */
  INDEXER_BATCH_SIZE: z.coerce.number().int().positive().max(10_000).default(2_000),

  /** Seconds between indexer passes. */
  INDEXER_POLL_INTERVAL: z.coerce.number().int().positive().default(12),

  /** Block the contracts were deployed in. Backfilling from genesis would be pointless work. */
  DEPLOY_BLOCK: z.coerce.bigint().default(0n),

  IPFS_GATEWAY: z.string().url().default('https://ipfs.io/ipfs/'),
  PINATA_JWT: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const config = Object.freeze(parsed.data);

export type Config = typeof config;
