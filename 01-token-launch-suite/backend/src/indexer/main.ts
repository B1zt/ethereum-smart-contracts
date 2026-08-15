import {Indexer} from './indexer.js';
import {logger} from '../lib/logger.js';
import {prisma} from '../lib/prisma.js';

/** Standalone indexer entrypoint, for when it should not share an event loop with the API. */
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
