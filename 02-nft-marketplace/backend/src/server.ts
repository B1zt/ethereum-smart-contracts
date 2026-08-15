import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, {type FastifyError, type FastifyInstance} from 'fastify';
import {auctionRoutes} from './auctions/routes.js';
import {collectionRoutes} from './collections/routes.js';
import {config} from './config.js';
import {loggerOptions} from './lib/logger.js';
import {prisma} from './lib/prisma.js';
import {merkleRoutes} from './merkle/routes.js';
import {orderRoutes} from './orders/routes.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions,
    // Trust the proxy so rate limiting keys on the real client IP behind a load balancer rather
    // than on the proxy's address, which would otherwise throttle every user as one.
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(cors, {
    origin: config.CORS_ORIGINS,
    methods: ['GET', 'POST', 'DELETE'],
  });

  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
  });

  app.get('/health', async () => {
    // A health check that does not touch the database is not a health check. This one fails when
    // Postgres is unreachable, which is what an orchestrator needs to know.
    await prisma.$queryRaw`SELECT 1`;
    return {status: 'ok', chainId: config.CHAIN_ID};
  });

  await app.register(
    async (api) => {
      await api.register(orderRoutes);
      await api.register(collectionRoutes);
      await api.register(auctionRoutes);
      await api.register(merkleRoutes);
    },
    {prefix: '/api/v1'},
  );

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({error}, 'request failed');

    const status = error.statusCode ?? 500;
    // Internal errors are logged in full but never echoed back: stack traces and driver messages
    // leak schema details to anyone who can send a malformed request.
    const message = status >= 500 ? 'Internal server error' : error.message;

    return reply.status(status).send({error: message});
  });

  return app;
}
