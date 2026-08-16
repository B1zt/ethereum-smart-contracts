/**
 * Demo data.
 *
 * The indexer fills these tables from chain events, so a fresh database and a chain with no history
 * look identical: every page renders its empty state. This writes a plausible slice of activity so
 * the UI can be clicked through immediately, and so the README screenshots show the app working.
 *
 * Safe to re-run: every table it touches is cleared first. For that same reason, only ever point it
 * at a local database.
 *
 *   pnpm db:seed
 */
import {PrismaClient} from '@prisma/client';

const prisma = new PrismaClient();

/** Anvil's default accounts. Public mnemonic, worthless anywhere real. */
const WALLETS = {
  deployer: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  alice: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
  bob: '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
  carol: '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
  dave: '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65',
  erin: '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc',
} as const;

const TOKEN = 10n ** 18n;

function fakeHash(prefix: string, index: number): string {
  const body = `${prefix}${index}`
    .split('')
    .map((character) => character.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('');
  return `0x${body.padEnd(64, '0').slice(0, 64)}`;
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 3_600_000);
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 86_400_000);
}

async function main(): Promise<void> {
  console.log('clearing existing demo data');

  await prisma.vote.deleteMany();
  await prisma.proposal.deleteMany();
  await prisma.votingPower.deleteMany();
  await prisma.stakeEvent.deleteMany();
  await prisma.stakePosition.deleteMany();
  await prisma.vaultSnapshot.deleteMany();
  await prisma.vestingRelease.deleteMany();
  await prisma.vestingSchedule.deleteMany();
  await prisma.airdropEntry.deleteMany();
  await prisma.airdropRoot.deleteMany();

  /* ---------------------------------------------------------------- airdrop --- */

  const airdrop = [
    {address: WALLETS.alice, amount: 12_500n, claimed: true},
    {address: WALLETS.bob, amount: 8_000n, claimed: true},
    {address: WALLETS.carol, amount: 25_000n, claimed: false},
    {address: WALLETS.dave, amount: 4_200n, claimed: false},
    {address: WALLETS.erin, amount: 60_000n, claimed: true},
  ];

  console.log(`seeding ${airdrop.length} airdrop entries`);

  await prisma.airdropEntry.createMany({
    data: airdrop.map((entry, index) => ({
      index,
      address: entry.address,
      amount: (entry.amount * TOKEN).toString(),
      claimedAt: entry.claimed ? hoursAgo(30 - index * 4) : null,
      claimTx: entry.claimed ? fakeHash('claim', index) : null,
    })),
  });

  await prisma.airdropRoot.create({
    data: {
      root: fakeHash('airdroproot', 1),
      entryCount: airdrop.length,
      totalAmount: (airdrop.reduce((sum, entry) => sum + entry.amount, 0n) * TOKEN).toString(),
      deadline: daysFromNow(74),
      isPublished: true,
    },
  });

  /* ---------------------------------------------------------------- vesting --- */

  const schedules = [
    {
      id: '0',
      beneficiary: WALLETS.alice,
      total: 250_000n,
      // 120 of 730 days vests about 41,095, so a claim of 25,000 leaves a real balance behind.
      released: 25_000n,
      startedDaysAgo: 120,
      cliffDays: 90,
      durationDays: 730,
      revocable: true,
    },
    {
      id: '1',
      beneficiary: WALLETS.bob,
      total: 400_000n,
      released: 0n,
      // Still inside its cliff, which is the case worth showing: allocated but not yet claimable.
      startedDaysAgo: 30,
      cliffDays: 180,
      durationDays: 1_095,
      revocable: true,
    },
    {
      id: '2',
      beneficiary: WALLETS.carol,
      total: 100_000n,
      released: 100_000n,
      startedDaysAgo: 800,
      cliffDays: 0,
      durationDays: 365,
      revocable: false,
    },
  ];

  console.log(`seeding ${schedules.length} vesting schedules`);

  for (const schedule of schedules) {
    await prisma.vestingSchedule.create({
      data: {
        id: schedule.id,
        beneficiary: schedule.beneficiary,
        total: (schedule.total * TOKEN).toString(),
        released: (schedule.released * TOKEN).toString(),
        startTime: hoursAgo(schedule.startedDaysAgo * 24),
        cliffSeconds: schedule.cliffDays * 86_400,
        durationSeconds: schedule.durationDays * 86_400,
        revocable: schedule.revocable,
        revoked: false,
      },
    });
  }

  await prisma.vestingRelease.createMany({
    data: [
      {scheduleId: '0', beneficiary: WALLETS.alice, amount: (15_000n * TOKEN).toString(), txHash: fakeHash('rel', 0), logIndex: 0, blockNumber: 120n, blockTime: hoursAgo(600)},
      {scheduleId: '0', beneficiary: WALLETS.alice, amount: (10_000n * TOKEN).toString(), txHash: fakeHash('rel', 1), logIndex: 0, blockNumber: 240n, blockTime: hoursAgo(180)},
      {scheduleId: '2', beneficiary: WALLETS.carol, amount: (100_000n * TOKEN).toString(), txHash: fakeHash('rel', 2), logIndex: 0, blockNumber: 90n, blockTime: hoursAgo(2_400)},
    ],
  });

  /* ---------------------------------------------------------------- staking --- */

  const stakers = [
    {address: WALLETS.alice, assets: 180_000n},
    {address: WALLETS.bob, assets: 95_000n},
    {address: WALLETS.carol, assets: 41_000n},
    {address: WALLETS.erin, assets: 12_500n},
  ];

  console.log(`seeding ${stakers.length} stake positions`);

  // Shares lag assets because the vault has earned rewards: one share is now worth more than one
  // token. A demo where price per share is exactly 1.0 hides the whole point of an ERC-4626 vault.
  const PRICE_PER_SHARE_BPS = 10_740n;

  for (const staker of stakers) {
    const assets = staker.assets * TOKEN;
    const shares = (assets * 10_000n) / PRICE_PER_SHARE_BPS;

    await prisma.stakePosition.create({
      data: {
        address: staker.address,
        shares: shares.toString(),
        netDeposited: assets.toString(),
      },
    });
  }

  await prisma.stakeEvent.createMany({
    data: stakers.flatMap((staker, index) => [
      {
        address: staker.address,
        kind: 'deposit',
        assets: (staker.assets * TOKEN).toString(),
        shares: ((staker.assets * TOKEN * 10_000n) / PRICE_PER_SHARE_BPS).toString(),
        txHash: fakeHash('stake', index),
        logIndex: 0,
        blockNumber: BigInt(300 + index),
        blockTime: hoursAgo(200 - index * 30),
      },
    ]),
  });

  const totalAssets = stakers.reduce((sum, staker) => sum + staker.assets, 0n) * TOKEN;
  const totalShares = (totalAssets * 10_000n) / PRICE_PER_SHARE_BPS;

  // A fortnight of daily snapshots, so the price per share chart has a shape.
  console.log('seeding 14 vault snapshots');

  await prisma.vaultSnapshot.createMany({
    data: Array.from({length: 14}, (_unused, day) => {
      const drift = 10_000n + BigInt(Math.round(day * 55));

      return {
        blockNumber: BigInt(1_000 + day),
        totalAssets: ((totalAssets * drift) / 10_000n).toString(),
        totalShares: totalShares.toString(),
        pricePerShare: (drift * 10n ** 14n).toString(),
        lockedRewards: (18_000n * TOKEN).toString(),
        aprBps: 1_180 + day * 9,
        capturedAt: hoursAgo((13 - day) * 24),
      };
    }),
  });

  /* ------------------------------------------------------------- governance --- */

  const proposals = [
    {
      id: '1',
      title: 'Raise staking rewards to 20,000 PRJ per week',
      state: 'ACTIVE' as const,
      forVotes: 412_000n,
      againstVotes: 88_000n,
      abstain: 21_000n,
      startsHoursAgo: 40,
      endsInHours: 56,
    },
    {
      id: '2',
      title: 'Fund a third-party audit of the staking vault',
      state: 'SUCCEEDED' as const,
      forVotes: 690_000n,
      againstVotes: 12_000n,
      abstain: 4_000n,
      startsHoursAgo: 220,
      endsInHours: -30,
    },
    {
      id: '3',
      title: 'Extend the airdrop claim deadline by 30 days',
      state: 'EXECUTED' as const,
      forVotes: 540_000n,
      againstVotes: 130_000n,
      abstain: 9_000n,
      startsHoursAgo: 500,
      endsInHours: -320,
    },
    {
      id: '4',
      title: 'Move the treasury multisig to a 4-of-7 threshold',
      state: 'DEFEATED' as const,
      forVotes: 96_000n,
      againstVotes: 380_000n,
      abstain: 40_000n,
      startsHoursAgo: 700,
      endsInHours: -520,
    },
  ];

  console.log(`seeding ${proposals.length} proposals`);

  for (const proposal of proposals) {
    await prisma.proposal.create({
      data: {
        id: proposal.id,
        proposer: WALLETS.deployer,
        description: proposal.title,
        targets: ['0x0000000000000000000000000000000000000000'],
        values: ['0'],
        calldatas: ['0x'],
        voteStart: hoursAgo(proposal.startsHoursAgo),
        voteEnd: new Date(Date.now() + proposal.endsInHours * 3_600_000),
        state: proposal.state,
        forVotes: (proposal.forVotes * TOKEN).toString(),
        againstVotes: (proposal.againstVotes * TOKEN).toString(),
        abstainVotes: (proposal.abstain * TOKEN).toString(),
        etaAt: proposal.state === 'SUCCEEDED' ? daysFromNow(1) : null,
        executedAt: proposal.state === 'EXECUTED' ? hoursAgo(300) : null,
        votes: {
          create: [
            {voter: WALLETS.alice, support: 'FOR', weight: (proposal.forVotes * TOKEN * 6n / 10n).toString(), reason: 'Good for the protocol.', txHash: fakeHash(`vote${proposal.id}`, 0), logIndex: 0, blockNumber: 500n, blockTime: hoursAgo(proposal.startsHoursAgo - 2)},
            {voter: WALLETS.bob, support: 'AGAINST', weight: (proposal.againstVotes * TOKEN).toString(), reason: null, txHash: fakeHash(`vote${proposal.id}`, 1), logIndex: 0, blockNumber: 505n, blockTime: hoursAgo(proposal.startsHoursAgo - 5)},
            {voter: WALLETS.carol, support: 'ABSTAIN', weight: (proposal.abstain * TOKEN).toString(), reason: null, txHash: fakeHash(`vote${proposal.id}`, 2), logIndex: 0, blockNumber: 510n, blockTime: hoursAgo(proposal.startsHoursAgo - 9)},
          ],
        },
      },
    });
  }

  await prisma.votingPower.createMany({
    data: [
      {address: WALLETS.alice, votes: (412_000n * TOKEN).toString(), delegatedTo: WALLETS.alice},
      {address: WALLETS.bob, votes: (380_000n * TOKEN).toString(), delegatedTo: WALLETS.bob},
      {address: WALLETS.carol, votes: (90_000n * TOKEN).toString(), delegatedTo: WALLETS.alice},
      {address: WALLETS.dave, votes: '0', delegatedTo: null},
    ],
  });

  console.log('\ndone.');
  console.log(`  ${airdrop.length} airdrop entries, ${schedules.length} vesting schedules`);
  console.log(`  ${stakers.length} stakers, ${proposals.length} proposals`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
