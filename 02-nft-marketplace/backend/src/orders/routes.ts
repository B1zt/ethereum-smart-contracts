import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {prisma} from '../lib/prisma.js';
import {submitOrderSchema, toOrderStruct, unitPrice, Side, TokenType} from './types.js';
import {validateOrder} from './validation.js';
import type {Hex} from 'viem';

const listQuerySchema = z.object({
  collection: z.string().optional(),
  tokenId: z.string().optional(),
  maker: z.string().optional(),
  side: z.enum(['LISTING', 'OFFER']).optional(),
  status: z.enum(['OPEN', 'FILLED', 'CANCELLED', 'EXPIRED', 'INVALID']).default('OPEN'),
  sort: z.enum(['price_asc', 'price_desc', 'newest']).default('price_asc'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

const sideToEnum = {[Side.Listing]: 'LISTING', [Side.Offer]: 'OFFER'} as const;
const tokenTypeToEnum = {[TokenType.ERC721]: 'ERC721', [TokenType.ERC1155]: 'ERC1155'} as const;

export async function orderRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Publish a signed order.
   *
   * The order is validated against live chain state before it is stored. Rejecting here is a
   * courtesy, not a security control: the contract enforces everything again at fill time. What it
   * buys is an order book where "available" means available, so buyers do not burn gas on fills
   * that were always going to revert.
   */
  app.post('/orders', async (request, reply) => {
    const parsed = submitOrderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({error: 'INVALID_BODY', issues: parsed.error.issues});
    }

    const {order, signature} = parsed.data;
    const struct = toOrderStruct(order);

    const result = await validateOrder(struct, signature as Hex);
    if (!result.ok) {
      return reply.status(422).send({error: 'ORDER_REJECTED', reasons: result.reasons});
    }

    const record = await prisma.order.upsert({
      where: {hash: result.hash},
      create: {
        hash: result.hash,
        maker: order.maker,
        collection: order.collection,
        tokenId: order.tokenId,
        amount: order.amount,
        currency: order.currency,
        price: order.price,
        unitPrice: unitPrice(struct.price, struct.amount).toString(),
        startTime: new Date(Number(struct.startTime) * 1000),
        endTime: new Date(Number(struct.endTime) * 1000),
        salt: order.salt,
        nonce: order.nonce,
        side: sideToEnum[order.side],
        tokenStandard: tokenTypeToEnum[order.tokenType],
        signature,
        filledAmount: result.filledAmount.toString(),
      },
      // Re-submitting the same order is idempotent. Wallets retry, and a duplicate submission
      // should return the existing order rather than a conflict.
      update: {signature, status: 'OPEN'},
    });

    return reply.status(201).send({order: record});
  });

  /** Browse the order book. */
  app.get('/orders', async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({error: 'INVALID_QUERY', issues: parsed.error.issues});
    }

    const {collection, tokenId, maker, side, status, sort, limit, cursor} = parsed.data;

    const orderBy =
      sort === 'newest'
        ? ([{createdAt: 'desc'}, {hash: 'asc'}] as const)
        : sort === 'price_desc'
          ? ([{unitPrice: 'desc'}, {hash: 'asc'}] as const)
          : ([{unitPrice: 'asc'}, {hash: 'asc'}] as const);

    const orders = await prisma.order.findMany({
      where: {
        ...(collection ? {collection: collection.toLowerCase()} : {}),
        ...(tokenId ? {tokenId} : {}),
        ...(maker ? {maker: maker.toLowerCase()} : {}),
        ...(side ? {side} : {}),
        status,
        // An OPEN order past its end time has simply not been swept yet. Filtering here keeps the
        // API honest between sweeps instead of showing a dead order for up to a minute.
        ...(status === 'OPEN' ? {endTime: {gt: new Date()}} : {}),
      },
      orderBy: [...orderBy],
      take: limit + 1,
      ...(cursor ? {cursor: {hash: cursor}, skip: 1} : {}),
    });

    const hasMore = orders.length > limit;
    const page = hasMore ? orders.slice(0, limit) : orders;

    return reply.send({
      orders: page,
      nextCursor: hasMore ? page[page.length - 1]?.hash : null,
    });
  });

  /** Fetch one order by its EIP-712 hash. */
  app.get('/orders/:hash', async (request, reply) => {
    const {hash} = request.params as {hash: string};

    const order = await prisma.order.findUnique({
      where: {hash},
      include: {fills: {orderBy: {blockTime: 'desc'}}},
    });

    if (!order) {
      return reply.status(404).send({error: 'NOT_FOUND'});
    }

    return reply.send({order});
  });

  /**
   * Re-check an order against current chain state.
   *
   * Useful for the "why can't I buy this?" case: a maker may have transferred the asset or revoked
   * approval since the order was published, and the sweeper has not caught it yet.
   */
  app.post('/orders/:hash/revalidate', async (request, reply) => {
    const {hash} = request.params as {hash: string};

    const stored = await prisma.order.findUnique({where: {hash}});
    if (!stored) {
      return reply.status(404).send({error: 'NOT_FOUND'});
    }

    const struct = toOrderStruct({
      maker: stored.maker as `0x${string}`,
      collection: stored.collection as `0x${string}`,
      tokenId: stored.tokenId,
      amount: stored.amount,
      currency: stored.currency as `0x${string}`,
      price: stored.price,
      startTime: String(Math.floor(stored.startTime.getTime() / 1000)),
      endTime: String(Math.floor(stored.endTime.getTime() / 1000)),
      salt: stored.salt,
      nonce: stored.nonce,
      side: stored.side === 'LISTING' ? Side.Listing : Side.Offer,
      tokenType: stored.tokenStandard === 'ERC721' ? TokenType.ERC721 : TokenType.ERC1155,
    });

    const result = await validateOrder(struct, stored.signature as Hex);

    const status = result.ok
      ? 'OPEN'
      : result.reasons.includes('ALREADY_FILLED')
        ? 'FILLED'
        : result.reasons.includes('CANCELLED_ON_CHAIN') || result.reasons.includes('STALE_NONCE')
          ? 'CANCELLED'
          : result.reasons.includes('EXPIRED')
            ? 'EXPIRED'
            : 'INVALID';

    const updated = await prisma.order.update({
      where: {hash},
      data: {status, filledAmount: result.filledAmount.toString()},
    });

    return reply.send({order: updated, valid: result.ok, reasons: result.reasons});
  });
}
