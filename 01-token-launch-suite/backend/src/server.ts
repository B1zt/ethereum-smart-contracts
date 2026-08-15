import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, {type FastifyError, type FastifyInstance} from 'fastify';
import {config} from './config.js';
import {loggerOptions} from './lib/logger.js';
import {prisma} from './lib/prisma.js';
import {apiRoutes} from './routes.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions,
    // Trust the proxy so rate limiting keys on the real client IP rather than the load balancer's,
    // which would otherwise throttle every user as if they were one.
    trustProxy: true,
    bodyLimit: 8 * 1024 * 1024, // airdrop uploads can carry tens of thousands of entries
  });

  await app.register(cors, {origin: config.CORS_ORIGINS, methods: ['GET', 'POST']});
  await app.register(rateLimit, {max: 300, timeWindow: '1 minute'});

  app.get('/health', async () => {
    // A health check that does not touch the database is not a health check.
    await prisma.$queryRaw`SELECT 1`;
    return {status: 'ok', chainId: config.CHAIN_ID};
  });

  await app.register(apiRoutes, {prefix: '/api/v1'});

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({error}, 'request failed');

    const status = error.statusCode ?? 500;
    // Internal errors are logged in full but never echoed back: stack traces and driver messages
    // leak schema details to anyone who can send a malformed request.
    return reply.status(status).send({error: status >= 500 ? 'Internal server error' : error.message});
  });

  return app;
}
