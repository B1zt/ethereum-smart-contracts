import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {auctionAbi} from '../chain/abis.js';
import {publicClient} from '../chain/client.js';
import {config} from '../config.js';
import {prisma} from '../lib/prisma.js';

const listSchema = z.object({
  status: z.enum(['ACTIVE', 'SETTLED', 'CANCELLED']).default('ACTIVE'),
  collection: z.string().optional(),
  seller: z.string().optional(),
  /** Auctions whose clock has run out but which nobody has settled yet. */
  endingSoon: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

export async function auctionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/auctions', async (request, reply) => {
    const parsed = listSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({error: 'INVALID_QUERY', issues: parsed.error.issues});
    }

    const {status, collection, seller, endingSoon, limit, cursor} = parsed.data;

    const auctions = await prisma.auction.findMany({
      where: {
        status,
        ...(collection ? {collection: collection.toLowerCase()} : {}),
        ...(seller ? {seller: seller.toLowerCase()} : {}),
        ...(endingSoon
          ? {endTime: {gt: new Date(), lte: new Date(Date.now() + 60 * 60 * 1000)}}
          : {}),
      },
      orderBy: endingSoon ? {endTime: 'asc'} : {createdAt: 'desc'},
      take: limit + 1,
      ...(cursor ? {cursor: {id: cursor}, skip: 1} : {}),
    });

    const hasMore = auctions.length > limit;
    const page = hasMore ? auctions.slice(0, limit) : auctions;

    return reply.send({
      auctions: page,
      nextCursor: hasMore ? page[page.length - 1]?.id : null,
    });
  });

  /**
   * One auction, with its bid history and the smallest bid that would currently be accepted.
   *
   * `minimumBid` is read from the contract rather than recomputed here. The increment rule involves
   * a rounding guard for tiny bids, and reimplementing it in the API would eventually disagree with
   * the chain and hand users a bid amount that reverts.
   */
  app.get('/auctions/:id', async (request, reply) => {
    const {id} = request.params as {id: string};

    const auction = await prisma.auction.findUnique({
      where: {id},
      include: {bids: {orderBy: {blockTime: 'desc'}}},
    });

    if (!auction) {
      return reply.status(404).send({error: 'NOT_FOUND'});
    }

    const minimumBid = await publicClient
      .readContract({
        address: config.AUCTION_ADDRESS,
        abi: auctionAbi,
        functionName: 'minimumBid',
        args: [BigInt(id)],
      })
      .catch(() => null);

    const now = Date.now();

    return reply.send({
      auction: {
        ...auction,
        minimumBid: minimumBid?.toString() ?? null,
        // A finished auction that nobody has settled yet still holds the asset in escrow. The UI
        // surfaces this as a "settle" call any wallet can make.
        isSettleable: auction.status === 'ACTIVE' && auction.endTime.getTime() <= now,
        secondsRemaining: Math.max(0, Math.floor((auction.endTime.getTime() - now) / 1000)),
      },
    });
  });

  /** Bid history for one auction. */
  app.get('/auctions/:id/bids', async (request, reply) => {
    const {id} = request.params as {id: string};

    const bids = await prisma.bid.findMany({
      where: {auctionId: id},
      orderBy: [{blockTime: 'desc'}, {logIndex: 'desc'}],
      take: 100,
    });

    return reply.send({bids});
  });
}
