import 'dotenv/config';
import {z} from 'zod';

/**
 * Environment is validated once at boot. A missing contract address or a malformed RPC URL should
 * crash the process immediately with a clear message, not surface an hour later as a confusing
 * runtime failure on the first request that happens to need it.
 */
const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte hex address')
  .transform((value) => value.toLowerCase() as `0x${string}`);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  PORT: z.coerce.number().int().positive().default(4001),
  HOST: z.string().default('0.0.0.0'),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((value) => value.split(',').map((origin) => origin.trim())),

  DATABASE_URL: z.string().url(),

  CHAIN_ID: z.coerce.number().int().positive().default(11155111),
  RPC_URL: z.string().url(),

  TOKEN_ADDRESS: addressSchema,
  TIMELOCK_ADDRESS: addressSchema,
  GOVERNOR_ADDRESS: addressSchema,
  VESTING_ADDRESS: addressSchema,
  DISTRIBUTOR_ADDRESS: addressSchema,
  VAULT_ADDRESS: addressSchema,

  /** Blocks below (head - CONFIRMATIONS) are final. Above it, logs are re-scanned every pass. */
  CONFIRMATIONS: z.coerce.number().int().nonnegative().default(12),
  INDEXER_BATCH_SIZE: z.coerce.number().int().positive().max(10_000).default(2_000),
  INDEXER_POLL_INTERVAL: z.coerce.number().int().positive().default(12),
  DEPLOY_BLOCK: z.coerce.bigint().default(0n),

  /** How often to snapshot vault share price for the yield chart, in seconds. */
  VAULT_SNAPSHOT_INTERVAL: z.coerce.number().int().positive().default(3_600),

  /**
   * Shared secret for the airdrop admin endpoints.
   *
   * Publishing a Merkle root decides who receives tokens, so those routes are not open. In a real
   * deployment this would be a proper auth layer; a bearer token keeps the demo honest about the
   * fact that the endpoint is privileged.
   */
  ADMIN_API_KEY: z.string().min(16).optional(),
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
