import {Indexer} from './indexer.js';
import {logger} from '../lib/logger.js';
import {prisma} from '../lib/prisma.js';

/**
 * Standalone indexer entrypoint.
 *
 * Run this instead of the combined process when the backfill is long enough that it would block
 * API requests, or when the two need to scale separately.
 */
async function main(): Promise<void> {
  const indexer = new Indexer();
  await indexer.start();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({signal}, 'shutting down indexer');
    indexer.stop();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  logger.fatal({error}, 'indexer failed to start');
  process.exit(1);
});
