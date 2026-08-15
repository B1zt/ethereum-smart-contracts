import {config} from './config.js';
import {Indexer} from './indexer/indexer.js';
import {logger} from './lib/logger.js';
import {prisma} from './lib/prisma.js';
import {buildServer} from './server.js';

/**
 * Single-process entrypoint: API and indexer together.
 *
 * Fine for a demo or a small deployment. At real volume the indexer should run as its own process
 * (`pnpm indexer`) so a slow backfill cannot starve the API's event loop, and so the two can scale
 * independently. Both entrypoints share the same code, so switching is a deployment change rather
 * than a rewrite.
 */
async function main(): Promise<void> {
  const app = await buildServer();
  const indexer = new Indexer();

  await app.listen({port: config.PORT, host: config.HOST});
  logger.info({port: config.PORT, chainId: config.CHAIN_ID}, 'api listening');

  await indexer.start();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({signal}, 'shutting down');

    indexer.stop();
    await app.close();
    await prisma.$disconnect();

    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  logger.fatal({error}, 'failed to start');
  process.exit(1);
});
