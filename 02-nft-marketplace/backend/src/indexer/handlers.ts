import {prisma} from '../lib/prisma.js';

/** Enriched log: viem's decoded shape plus the block timestamp we resolve separately. */
export interface DecodedEvent {
  eventName: string;
  args: Record<string, unknown>;
  txHash: `0x${string}`;
  logIndex: number;
  blockNumber: bigint;
  blockTime: Date;
}

const sideFromUint = (value: number): 'LISTING' | 'OFFER' => (value === 0 ? 'LISTING' : 'OFFER');

const standardFromUint = (value: number): 'ERC721' | 'ERC1155' =>
  value === 0 ? 'ERC721' : 'ERC1155';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Record a settled trade and reconcile the order it filled.
 *
 * The insert is keyed on `(txHash, logIndex)`, which is what makes reindexing safe: replaying the
 * same block range cannot double-count a sale, so a crashed indexer can simply resume without
 * anyone reasoning about where exactly it stopped.
 */
export async function handleOrderFilled(event: DecodedEvent): Promise<void> {
  const args = event.args as {
    orderHash: `0x${string}`;
    maker: `0x${string}`;
    taker: `0x${string}`;
    collection: `0x${string}`;
    tokenId: bigint;
    amount: bigint;
    currency: `0x${string}`;
    price: bigint;
    side: number;
  };

  const existing = await prisma.fill.findUnique({
    where: {txHash_logIndex: {txHash: event.txHash, logIndex: event.logIndex}},
  });

  if (existing) return;

  await prisma.$transaction(async (tx) => {
    await tx.fill.create({
      data: {
        orderHash: args.orderHash,
        maker: args.maker.toLowerCase(),
        taker: args.taker.toLowerCase(),
        collection: args.collection.toLowerCase(),
        tokenId: args.tokenId.toString(),
        amount: args.amount.toString(),
        currency: args.currency.toLowerCase(),
        price: args.price.toString(),
        side: sideFromUint(args.side),
        txHash: event.txHash,
        logIndex: event.logIndex,
        blockNumber: event.blockNumber,
        blockTime: event.blockTime,
      },
    });

    const order = await tx.order.findUnique({where: {hash: args.orderHash}});
    if (!order) return;

    // ERC-1155 orders fill in pieces, so the order only closes once the last unit is taken.
    const filled = BigInt(order.filledAmount) + args.amount;
    const fullyFilled = filled >= BigInt(order.amount);

    await tx.order.update({
      where: {hash: args.orderHash},
      data: {filledAmount: filled.toString(), status: fullyFilled ? 'FILLED' : 'OPEN'},
    });
  });

  await refreshCollectionStats(args.collection.toLowerCase());
}

export async function handleOrderCancelled(event: DecodedEvent): Promise<void> {
  const args = event.args as {orderHash: `0x${string}`};

  await prisma.order.updateMany({
    where: {hash: args.orderHash, status: {not: 'FILLED'}},
    data: {status: 'CANCELLED'},
  });
}

/**
 * A nonce bump invalidates every order the maker signed under the old value in one shot.
 *
 * That is the whole point of the mechanism on-chain, and the order book has to mirror it: leaving
 * those orders OPEN would show buyers listings that are guaranteed to revert.
 */
export async function handleNonceIncremented(event: DecodedEvent): Promise<void> {
  const args = event.args as {maker: `0x${string}`; newNonce: bigint};

  await prisma.order.updateMany({
    where: {
      maker: args.maker.toLowerCase(),
      nonce: {lt: args.newNonce.toString()},
      status: 'OPEN',
    },
    data: {status: 'CANCELLED'},
  });
}

/** Maintain current ownership from Transfer logs. */
export async function handleTransfer(event: DecodedEvent, collection: string): Promise<void> {
  const args = event.args as {from: `0x${string}`; to: `0x${string}`; tokenId: bigint};

  const tokenId = args.tokenId.toString();
  const from = args.from.toLowerCase();
  const to = args.to.toLowerCase();

  await prisma.$transaction(async (tx) => {
    if (from !== ZERO_ADDRESS) {
      await tx.tokenOwnership.deleteMany({where: {collection, tokenId, owner: from}});
    }

    if (to !== ZERO_ADDRESS) {
      await tx.tokenOwnership.upsert({
        where: {collection_tokenId_owner: {collection, tokenId, owner: to}},
        create: {collection, tokenId, owner: to, balance: '1'},
        update: {balance: '1'},
      });
    }

    // The previous owner's open listings for this token can no longer settle. Marking them INVALID
    // rather than deleting keeps the history readable on their profile page.
    if (from !== ZERO_ADDRESS) {
      await tx.order.updateMany({
        where: {collection, tokenId, maker: from, side: 'LISTING', status: 'OPEN'},
        data: {status: 'INVALID'},
      });
    }
  });
}

export async function handleAuctionCreated(event: DecodedEvent): Promise<void> {
  const args = event.args as {
    auctionId: bigint;
    seller: `0x${string}`;
    collection: `0x${string}`;
    auction: {
      tokenId: bigint;
      amount: bigint;
      currency: `0x${string}`;
      reservePrice: bigint;
      startTime: bigint;
      endTime: bigint;
      tokenType: number;
    };
  };

  const {auction} = args;

  await prisma.auction.upsert({
    where: {id: args.auctionId.toString()},
    create: {
      id: args.auctionId.toString(),
      seller: args.seller.toLowerCase(),
      collection: args.collection.toLowerCase(),
      tokenId: auction.tokenId.toString(),
      amount: auction.amount.toString(),
      currency: auction.currency.toLowerCase(),
      reservePrice: auction.reservePrice.toString(),
      startTime: new Date(Number(auction.startTime) * 1000),
      endTime: new Date(Number(auction.endTime) * 1000),
      tokenStandard: standardFromUint(auction.tokenType),
      status: 'ACTIVE',
    },
    update: {},
  });
}

/**
 * Record a bid and move the auction's end time.
 *
 * `newEndTime` comes from the event rather than being recomputed here, because the contract may
 * have extended it under the anti-snipe rule. Deriving it locally would mean reimplementing that
 * rule in two places and eventually getting them out of step.
 */
export async function handleBidPlaced(event: DecodedEvent): Promise<void> {
  const args = event.args as {
    auctionId: bigint;
    bidder: `0x${string}`;
    amount: bigint;
    newEndTime: bigint;
  };

  const auctionId = args.auctionId.toString();

  const existing = await prisma.bid.findUnique({
    where: {txHash_logIndex: {txHash: event.txHash, logIndex: event.logIndex}},
  });

  if (existing) return;

  await prisma.$transaction(async (tx) => {
    await tx.bid.create({
      data: {
        auctionId,
        bidder: args.bidder.toLowerCase(),
        amount: args.amount.toString(),
        txHash: event.txHash,
        logIndex: event.logIndex,
        blockNumber: event.blockNumber,
        blockTime: event.blockTime,
      },
    });

    await tx.auction.update({
      where: {id: auctionId},
      data: {
        highestBid: args.amount.toString(),
        highestBidder: args.bidder.toLowerCase(),
        endTime: new Date(Number(args.newEndTime) * 1000),
      },
    });
  });
}

export async function handleAuctionSettled(event: DecodedEvent): Promise<void> {
  const args = event.args as {auctionId: bigint; winner: `0x${string}`; amount: bigint};

  await prisma.auction.update({
    where: {id: args.auctionId.toString()},
    data: {
      status: 'SETTLED',
      highestBidder: args.winner === ZERO_ADDRESS ? null : args.winner.toLowerCase(),
      highestBid: args.amount === 0n ? null : args.amount.toString(),
    },
  });
}

export async function handleAuctionCancelled(event: DecodedEvent): Promise<void> {
  const args = event.args as {auctionId: bigint};

  await prisma.auction.update({
    where: {id: args.auctionId.toString()},
    data: {status: 'CANCELLED'},
  });
}

/**
 * Recompute a collection's rolled-up stats.
 *
 * Floor price is derived from open listings rather than stored incrementally. Incremental
 * maintenance is faster but drifts the moment a single update is missed, and a wrong floor price is
 * the most visible possible bug on a marketplace front page.
 */
export async function refreshCollectionStats(collection: string): Promise<void> {
  const [cheapest, volumeRows, holders] = await Promise.all([
    prisma.order.findFirst({
      where: {collection, side: 'LISTING', status: 'OPEN', endTime: {gt: new Date()}},
      orderBy: {unitPrice: 'asc'},
      select: {unitPrice: true},
    }),
    prisma.fill.findMany({where: {collection}, select: {price: true, blockTime: true}}),
    prisma.tokenOwnership.findMany({
      where: {collection},
      select: {owner: true},
      distinct: ['owner'],
    }),
  ]);

  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  let volumeAllTime = 0n;
  let volume24h = 0n;

  for (const row of volumeRows) {
    const price = BigInt(row.price);
    volumeAllTime += price;
    if (row.blockTime.getTime() >= dayAgo) volume24h += price;
  }

  await prisma.collection.updateMany({
    where: {address: collection},
    data: {
      floorPrice: cheapest?.unitPrice ?? null,
      volumeAllTime: volumeAllTime.toString(),
      volume24h: volume24h.toString(),
      ownerCount: holders.length,
    },
  });
}

/** Mark expired orders. Cheap to run often, and keeps the book honest between requests. */
export async function sweepExpiredOrders(): Promise<number> {
  const result = await prisma.order.updateMany({
    where: {status: 'OPEN', endTime: {lte: new Date()}},
    data: {status: 'EXPIRED'},
  });

  return result.count;
}
