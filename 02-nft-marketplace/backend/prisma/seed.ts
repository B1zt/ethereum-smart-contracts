/**
 * Demo data.
 *
 * The indexer fills these tables from chain events, which means an empty database and a chain with
 * no history look identical: every page renders its empty state and there is nothing to review.
 * This writes a plausible slice of activity so the UI can be clicked through immediately, and so
 * the screenshots in the README show the app doing something.
 *
 * It is safe to re-run: every table it touches is cleared first. It is not safe to point at
 * anything but a local database, for the same reason.
 *
 *   pnpm db:seed
 */
import {PrismaClient} from '@prisma/client';

const prisma = new PrismaClient();

/** Anvil's default accounts. Public mnemonic, so these are worthless anywhere real. */
const WALLETS = {
  deployer: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  alice: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
  bob: '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
  carol: '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
  dave: '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65',
} as const;

const COLLECTION = (
  process.env.COLLECTION_ADDRESS ?? '0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0'
).toLowerCase();

const AUCTION_HOUSE = (
  process.env.AUCTION_ADDRESS ?? '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512'
).toLowerCase();

const ETH = 10n ** 18n;

/** Deterministic pseudo-hex, so re-running produces the same ids rather than churning rows. */
function fakeHash(prefix: string, index: number): string {
  const body = `${prefix}${index}`
    .split('')
    .map((character) => character.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('');
  return `0x${body.padEnd(64, '0').slice(0, 64)}`;
}

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60_000);
}

/**
 * OpenSea-style attributes: an array of {trait_type, value}, not an object keyed by trait name.
 * The frontend's facet panel iterates this, so the shape has to match what a real token URI serves.
 */
function traitsFor(background: string, eyes: string, rarity: string) {
  return [
    {trait_type: 'Background', value: background},
    {trait_type: 'Eyes', value: eyes},
    {trait_type: 'Rarity', value: rarity},
  ];
}

const TRAITS = [
  traitsFor('Cobalt', 'Laser', 'Rare'),
  traitsFor('Sand', 'Calm', 'Common'),
  traitsFor('Void', 'Visor', 'Legendary'),
  traitsFor('Moss', 'Sleepy', 'Common'),
  traitsFor('Ember', 'Laser', 'Epic'),
];

async function main(): Promise<void> {
  console.log('clearing existing demo data');

  await prisma.bid.deleteMany();
  await prisma.auction.deleteMany();
  await prisma.fill.deleteMany();
  await prisma.order.deleteMany();
  await prisma.allowlistEntry.deleteMany();
  await prisma.allowlist.deleteMany();
  await prisma.tokenMetadata.deleteMany();
  await prisma.tokenOwnership.deleteMany();
  await prisma.collection.deleteMany();

  const holders = [WALLETS.alice, WALLETS.bob, WALLETS.carol, WALLETS.deployer];

  // 95 tokens, matching what script/Demo.s.sol mints on chain. Keeping the two in step means the
  // live supply read and the indexed ownership rows agree, which is what a working system looks
  // like; a mismatch would be the first thing a reviewer noticed.
  const TOTAL = 95;
  const ownerFor = (tokenId: number): string => {
    if (tokenId < 40) return WALLETS.alice;
    if (tokenId < 65) return WALLETS.bob;
    if (tokenId < 83) return WALLETS.carol;
    return WALLETS.deployer;
  };

  await prisma.collection.create({
    data: {
      address: COLLECTION,
      name: 'B1zt Genesis',
      symbol: 'BZG',
      standard: 'ERC721',
      deployBlock: 1n,
      totalSupply: String(TOTAL),
      floorPrice: (ETH / 10n).toString(),
      volumeAllTime: (ETH * 412n / 10n).toString(),
      volume24h: (ETH * 37n / 10n).toString(),
      ownerCount: holders.length,
      isVerified: true,
    },
  });

  console.log(`seeding ${TOTAL} tokens`);

  await prisma.tokenOwnership.createMany({
    data: Array.from({length: TOTAL}, (_unused, tokenId) => ({
      collection: COLLECTION,
      tokenId: String(tokenId),
      owner: ownerFor(tokenId),
      balance: '1',
    })),
  });

  await prisma.tokenMetadata.createMany({
    data: Array.from({length: TOTAL}, (_unused, tokenId) => ({
      collection: COLLECTION,
      tokenId: String(tokenId),
      name: `B1zt Genesis #${tokenId}`,
      description: 'Demo metadata. On a real deployment this is fetched from the token URI.',
      imageUrl: `https://picsum.photos/seed/b1zt${tokenId}/600/600`,
      thumbnailUrl: `https://picsum.photos/seed/b1zt${tokenId}/240/240`,
      attributes: TRAITS[tokenId % TRAITS.length],
      revealedAt: minutesAgo(600),
    })),
  });

  // Active listings, cheapest first so the floor price above is the one the grid actually shows.
  const listingPrices = [10n, 12n, 14n, 15n, 18n, 22n, 26n, 31n, 40n, 55n];

  console.log(`seeding ${listingPrices.length} listings`);

  await prisma.order.createMany({
    data: listingPrices.map((tenths, index) => {
      const tokenId = index * 7 + 3;
      const price = (ETH * tenths) / 100n;

      return {
        hash: fakeHash('listing', index),
        maker: ownerFor(tokenId),
        collection: COLLECTION,
        tokenId: String(tokenId),
        amount: '1',
        currency: '0x0000000000000000000000000000000000000000',
        price: price.toString(),
        unitPrice: price.toString(),
        startTime: minutesAgo(600 - index * 20),
        endTime: new Date(Date.now() + (7 + index) * 86_400_000),
        salt: String(1_000 + index),
        nonce: '0',
        side: 'LISTING' as const,
        tokenStandard: 'ERC721' as const,
        signature: fakeHash('sig', index),
        status: 'OPEN' as const,
      };
    }),
  });

  // Offers sit below the floor, which is what makes an order book worth rendering.
  await prisma.order.createMany({
    data: [8n, 9n, 11n].map((tenths, index) => {
      const price = (ETH * tenths) / 100n;

      return {
        hash: fakeHash('offer', index),
        maker: [WALLETS.dave, WALLETS.carol, WALLETS.bob][index]!,
        collection: COLLECTION,
        tokenId: String(index * 7 + 3),
        amount: '1',
        currency: '0x0000000000000000000000000000000000000000',
        price: price.toString(),
        unitPrice: price.toString(),
        startTime: minutesAgo(300),
        endTime: new Date(Date.now() + 3 * 86_400_000),
        salt: String(2_000 + index),
        nonce: '0',
        side: 'OFFER' as const,
        tokenStandard: 'ERC721' as const,
        signature: fakeHash('offersig', index),
        status: 'OPEN' as const,
      };
    }),
  });

  // Sale history. Prices wander rather than climbing monotonically, because a chart that only goes
  // up reads as fabricated.
  const salePrices = [9n, 14n, 11n, 17n, 13n, 21n, 16n, 24n, 19n, 28n, 23n, 31n];

  console.log(`seeding ${salePrices.length} sales`);

  await prisma.fill.createMany({
    data: salePrices.map((tenths, index) => {
      const price = (ETH * tenths) / 100n;
      const seller = holders[index % holders.length]!;
      const taker = holders[(index + 2) % holders.length]!;

      return {
        orderHash: null,
        maker: seller,
        taker,
        collection: COLLECTION,
        // Deliberately the same tokens the listings above cover, so an item page shows a price
        // history rather than a listing floating above "no sales yet".
        tokenId: String((index % 10) * 7 + 3),
        amount: '1',
        currency: '0x0000000000000000000000000000000000000000',
        price: price.toString(),
        side: 'LISTING' as const,
        txHash: fakeHash('fill', index),
        logIndex: 0,
        blockNumber: BigInt(200 + index),
        blockTime: minutesAgo((salePrices.length - index) * 95),
      };
    }),
  });

  // A live auction with a bidding war, matching the one script/Demo.s.sol creates on chain.
  console.log('seeding auctions with bids');

  await prisma.auction.create({
    data: {
      id: '0',
      seller: WALLETS.deployer,
      collection: COLLECTION,
      tokenId: '84',
      amount: '1',
      currency: '0x0000000000000000000000000000000000000000',
      reservePrice: (ETH / 2n).toString(),
      highestBid: (ETH * 78n / 100n).toString(),
      highestBidder: WALLETS.carol,
      startTime: minutesAgo(240),
      endTime: new Date(Date.now() + 2 * 86_400_000),
      tokenStandard: 'ERC721',
      status: 'ACTIVE',
      bids: {
        create: [
          {bidder: WALLETS.alice, amount: (ETH / 2n).toString(), txHash: fakeHash('bid', 0), logIndex: 0, blockNumber: 300n, blockTime: minutesAgo(220)},
          {bidder: WALLETS.bob, amount: (ETH * 62n / 100n).toString(), txHash: fakeHash('bid', 1), logIndex: 0, blockNumber: 310n, blockTime: minutesAgo(140)},
          {bidder: WALLETS.carol, amount: (ETH * 78n / 100n).toString(), txHash: fakeHash('bid', 2), logIndex: 0, blockNumber: 320n, blockTime: minutesAgo(35)},
        ],
      },
    },
  });

  // Three more, so the auctions page shows the states that actually differ: one closing inside the
  // anti-snipe window, one with only the reserve met, and one already settled.
  const extraAuctions = [
    {
      id: '1',
      tokenId: '85',
      seller: WALLETS.deployer,
      reserve: 12n,
      highest: 34n,
      bidder: WALLETS.alice,
      endsInMinutes: 7,
      status: 'ACTIVE' as const,
    },
    {
      id: '2',
      tokenId: '86',
      seller: WALLETS.deployer,
      reserve: 25n,
      highest: 25n,
      bidder: WALLETS.bob,
      endsInMinutes: 60 * 30,
      status: 'ACTIVE' as const,
    },
    {
      id: '3',
      tokenId: '41',
      seller: WALLETS.bob,
      reserve: 15n,
      highest: 52n,
      bidder: WALLETS.carol,
      endsInMinutes: -60 * 12,
      status: 'SETTLED' as const,
    },
  ];

  for (const entry of extraAuctions) {
    await prisma.auction.create({
      data: {
        id: entry.id,
        seller: entry.seller,
        collection: COLLECTION,
        tokenId: entry.tokenId,
        amount: '1',
        currency: '0x0000000000000000000000000000000000000000',
        reservePrice: ((ETH * entry.reserve) / 100n).toString(),
        highestBid: ((ETH * entry.highest) / 100n).toString(),
        highestBidder: entry.bidder,
        startTime: minutesAgo(60 * 24),
        endTime: new Date(Date.now() + entry.endsInMinutes * 60_000),
        tokenStandard: 'ERC721',
        status: entry.status,
        bids: {
          create: [
            {
              bidder: entry.bidder,
              amount: ((ETH * entry.highest) / 100n).toString(),
              txHash: fakeHash(`bid${entry.id}`, 0),
              logIndex: 0,
              blockNumber: BigInt(400 + Number(entry.id)),
              blockTime: minutesAgo(90),
            },
          ],
        },
      },
    });
  }

  // The allowlist for phase 0. The on-chain root commits to these without revealing them, so this
  // table is the only place a proof can be generated from.
  const allowlist = await prisma.allowlist.create({
    data: {
      collection: COLLECTION,
      phaseId: 0,
      root: fakeHash('root', 0),
    },
  });

  await prisma.allowlistEntry.createMany({
    data: [
      {allowlistId: allowlist.id, address: WALLETS.alice, allowance: 3, leafIndex: 0},
      {allowlistId: allowlist.id, address: WALLETS.bob, allowance: 2, leafIndex: 1},
      {allowlistId: allowlist.id, address: WALLETS.carol, allowance: 5, leafIndex: 2},
    ],
  });

  console.log(`\ndone. collection ${COLLECTION}`);
  console.log(`  ${TOTAL} tokens across ${holders.length} holders`);
  console.log(`  ${listingPrices.length} listings, ${salePrices.length} sales, 1 live auction`);
  console.log(`\nauction house ${AUCTION_HOUSE}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
