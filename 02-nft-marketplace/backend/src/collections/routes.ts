import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {collectionAbi} from '../chain/abis.js';
import {publicClient} from '../chain/client.js';
import {config} from '../config.js';
import {prisma} from '../lib/prisma.js';

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

const activitySchema = paginationSchema.extend({
  tokenId: z.string().optional(),
});

/**
 * Trait filters arrive as repeated query params: `?trait=Background:Blue&trait=Eyes:Laser`.
 *
 * Filters within the same trait type are OR'd and different trait types are AND'd, which is what
 * every NFT marketplace does and what users expect: "Blue or Red background, and laser eyes".
 */
function parseTraitFilters(raw: unknown): Map<string, string[]> {
  const filters = new Map<string, string[]>();
  const values = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];

  for (const value of values) {
    if (typeof value !== 'string') continue;

    const separator = value.indexOf(':');
    if (separator <= 0) continue;

    const traitType = value.slice(0, separator);
    const traitValue = value.slice(separator + 1);

    const existing = filters.get(traitType) ?? [];
    existing.push(traitValue);
    filters.set(traitType, existing);
  }

  return filters;
}

export async function collectionRoutes(app: FastifyInstance): Promise<void> {
  /** Collection overview: on-chain supply plus indexed stats. */
  app.get('/collections/:address', async (request, reply) => {
    const {address} = request.params as {address: string};
    const collection = address.toLowerCase();

    const record = await prisma.collection.findUnique({where: {address: collection}});
    if (!record) {
      return reply.status(404).send({error: 'NOT_FOUND'});
    }

    // Supply and reveal state are read live rather than indexed. They change rarely and are the
    // two fields where showing a stale value is most obviously wrong on a mint page.
    const [totalMinted, maxSupply, revealed] = await Promise.all([
      publicClient
        .readContract({address: collection as `0x${string}`, abi: collectionAbi, functionName: 'totalMinted'})
        .catch(() => 0n),
      publicClient
        .readContract({address: collection as `0x${string}`, abi: collectionAbi, functionName: 'maxSupply'})
        .catch(() => 0n),
      publicClient
        .readContract({address: collection as `0x${string}`, abi: collectionAbi, functionName: 'revealed'})
        .catch(() => false),
    ]);

    return reply.send({
      collection: {
        ...record,
        totalMinted: totalMinted.toString(),
        maxSupply: maxSupply.toString(),
        revealed,
      },
    });
  });

  /** Live mint phase configuration, read straight from the contract. */
  app.get('/collections/:address/phases', async (request, reply) => {
    const {address} = request.params as {address: string};
    const collection = address.toLowerCase() as `0x${string}`;

    const phaseCount = await publicClient
      .readContract({address: collection, abi: collectionAbi, functionName: 'phaseCount'})
      .catch(() => 0n);

    const phases = await Promise.all(
      Array.from({length: Number(phaseCount)}, (_unused, phaseId) =>
        publicClient.readContract({
          address: collection,
          abi: collectionAbi,
          functionName: 'phases',
          args: [BigInt(phaseId)],
        }),
      ),
    );

    return reply.send({
      phases: phases.map((phase, phaseId) => ({
        phaseId,
        merkleRoot: phase.merkleRoot,
        price: phase.price.toString(),
        startTime: Number(phase.startTime),
        endTime: Number(phase.endTime),
        maxPerWallet: phase.maxPerWallet,
        maxSupply: phase.maxSupply,
        // A zero root means the phase is open to everyone, which the UI renders differently.
        isPublic: phase.merkleRoot === `0x${'0'.repeat(64)}`,
      })),
    });
  });

  /** How many units a wallet has already taken in a phase, for the mint page's remaining counter. */
  app.get('/collections/:address/phases/:phaseId/minted/:wallet', async (request, reply) => {
    const params = request.params as {address: string; phaseId: string; wallet: string};

    const minted = await publicClient
      .readContract({
        address: params.address.toLowerCase() as `0x${string}`,
        abi: collectionAbi,
        functionName: 'walletMinted',
        args: [BigInt(params.phaseId), params.wallet.toLowerCase() as `0x${string}`],
      })
      .catch(() => 0n);

    return reply.send({minted: minted.toString()});
  });

  /** Browse tokens, with optional trait filtering. */
  app.get('/collections/:address/tokens', async (request, reply) => {
    const {address} = request.params as {address: string};
    const parsed = paginationSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({error: 'INVALID_QUERY', issues: parsed.error.issues});
    }

    const collection = address.toLowerCase();
    const {limit, cursor} = parsed.data;
    const traitFilters = parseTraitFilters((request.query as Record<string, unknown>).trait);

    const tokens = await prisma.tokenMetadata.findMany({
      where: {
        collection,
        // Postgres JSON containment: each trait type must match at least one requested value.
        ...(traitFilters.size > 0
          ? {
              AND: [...traitFilters.entries()].map(([traitType, values]) => ({
                OR: values.map((value) => ({
                  attributes: {
                    array_contains: [{trait_type: traitType, value}],
                  },
                })),
              })),
            }
          : {}),
      },
      orderBy: {tokenId: 'asc'},
      take: limit + 1,
      ...(cursor ? {cursor: {id: cursor}, skip: 1} : {}),
    });

    const hasMore = tokens.length > limit;
    const page = hasMore ? tokens.slice(0, limit) : tokens;

    // Attach the cheapest open listing per token so the grid can show prices in one round trip.
    const listings = await prisma.order.findMany({
      where: {
        collection,
        tokenId: {in: page.map((token) => token.tokenId)},
        side: 'LISTING',
        status: 'OPEN',
        endTime: {gt: new Date()},
      },
      orderBy: {unitPrice: 'asc'},
    });

    const cheapestByToken = new Map<string, (typeof listings)[number]>();
    for (const listing of listings) {
      if (!cheapestByToken.has(listing.tokenId)) {
        cheapestByToken.set(listing.tokenId, listing);
      }
    }

    return reply.send({
      tokens: page.map((token) => ({
        ...token,
        listing: cheapestByToken.get(token.tokenId) ?? null,
      })),
      nextCursor: hasMore ? page[page.length - 1]?.id : null,
    });
  });

  /** Everything about one token: metadata, owner, live orders and sale history. */
  app.get('/collections/:address/tokens/:tokenId', async (request, reply) => {
    const params = request.params as {address: string; tokenId: string};
    const collection = params.address.toLowerCase();

    const [metadata, ownership, orders, fills] = await Promise.all([
      prisma.tokenMetadata.findUnique({
        where: {collection_tokenId: {collection, tokenId: params.tokenId}},
      }),
      prisma.tokenOwnership.findMany({where: {collection, tokenId: params.tokenId}}),
      prisma.order.findMany({
        where: {collection, tokenId: params.tokenId, status: 'OPEN', endTime: {gt: new Date()}},
        orderBy: {unitPrice: 'asc'},
      }),
      prisma.fill.findMany({
        where: {collection, tokenId: params.tokenId},
        orderBy: {blockTime: 'desc'},
        take: 20,
      }),
    ]);

    if (!metadata && ownership.length === 0) {
      return reply.status(404).send({error: 'NOT_FOUND'});
    }

    return reply.send({
      token: {
        collection,
        tokenId: params.tokenId,
        metadata,
        owners: ownership,
        listings: orders.filter((order) => order.side === 'LISTING'),
        offers: orders.filter((order) => order.side === 'OFFER'),
        history: fills,
      },
    });
  });

  /** Sale feed for a collection, newest first. */
  app.get('/collections/:address/activity', async (request, reply) => {
    const {address} = request.params as {address: string};
    const parsed = activitySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({error: 'INVALID_QUERY', issues: parsed.error.issues});
    }

    const {limit, cursor, tokenId} = parsed.data;

    const fills = await prisma.fill.findMany({
      where: {collection: address.toLowerCase(), ...(tokenId ? {tokenId} : {})},
      orderBy: [{blockTime: 'desc'}, {logIndex: 'desc'}],
      take: limit + 1,
      ...(cursor ? {cursor: {id: cursor}, skip: 1} : {}),
    });

    const hasMore = fills.length > limit;
    const page = hasMore ? fills.slice(0, limit) : fills;

    return reply.send({
      activity: page,
      nextCursor: hasMore ? page[page.length - 1]?.id : null,
    });
  });

  /** A wallet's holdings and open orders, for the portfolio page. */
  app.get('/portfolio/:wallet', async (request, reply) => {
    const {wallet} = request.params as {wallet: string};
    const owner = wallet.toLowerCase();

    const [holdings, orders, escrowed] = await Promise.all([
      prisma.tokenOwnership.findMany({where: {owner}, orderBy: {updatedAt: 'desc'}}),
      prisma.order.findMany({
        where: {maker: owner, status: 'OPEN', endTime: {gt: new Date()}},
        orderBy: {createdAt: 'desc'},
      }),
      prisma.auction.findMany({
        where: {OR: [{seller: owner}, {highestBidder: owner}], status: 'ACTIVE'},
      }),
    ]);

    // Join metadata in one query rather than N.
    const metadata = await prisma.tokenMetadata.findMany({
      where: {
        OR: holdings.map((holding) => ({
          collection: holding.collection,
          tokenId: holding.tokenId,
        })),
      },
    });

    const metadataKey = (collection: string, tokenId: string) => `${collection}:${tokenId}`;
    const metadataByToken = new Map(
      metadata.map((item) => [metadataKey(item.collection, item.tokenId), item]),
    );

    return reply.send({
      wallet: owner,
      holdings: holdings.map((holding) => ({
        ...holding,
        metadata: metadataByToken.get(metadataKey(holding.collection, holding.tokenId)) ?? null,
      })),
      listings: orders.filter((order) => order.side === 'LISTING'),
      offers: orders.filter((order) => order.side === 'OFFER'),
      auctions: escrowed,
    });
  });

  /** Contract addresses and chain id, so the frontend has a single source of truth. */
  app.get('/config', async (_request, reply) =>
    reply.send({
      chainId: config.CHAIN_ID,
      marketplace: config.MARKETPLACE_ADDRESS,
      auction: config.AUCTION_ADDRESS,
      collection: config.COLLECTION_ADDRESS,
    }),
  );
}
