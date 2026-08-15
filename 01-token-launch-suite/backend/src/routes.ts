import type {FastifyInstance, FastifyRequest} from 'fastify';
import {z} from 'zod';
import {AirdropTree, type AirdropEntry} from './airdrop/tree.js';
import {
  distributorAbi,
  governorAbi,
  PROPOSAL_STATES,
  tokenAbi,
  vaultAbi,
  vestingAbi,
} from './chain/abis.js';
import {publicClient} from './chain/client.js';
import {config} from './config.js';
import {prisma} from './lib/prisma.js';

const addressParam = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'invalid address');

/**
 * Rebuild the airdrop tree from stored entries.
 *
 * Only the entries are persisted, never the tree. A tree is a pure function of its entries, so
 * storing it would create a second source of truth that can silently drift from the first.
 */
async function loadAirdropTree(): Promise<AirdropTree | null> {
  const rows = await prisma.airdropEntry.findMany({orderBy: {index: 'asc'}});
  if (rows.length === 0) return null;

  const entries: AirdropEntry[] = rows.map((row) => ({
    index: row.index,
    address: row.address as `0x${string}`,
    amount: BigInt(row.amount),
  }));

  return new AirdropTree(entries);
}

/** Bearer check for the privileged airdrop routes. */
function requireAdmin(request: FastifyRequest): boolean {
  if (!config.ADMIN_API_KEY) return false;

  const header = request.headers.authorization;
  return header === `Bearer ${config.ADMIN_API_KEY}`;
}

export async function apiRoutes(app: FastifyInstance): Promise<void> {
  /*//////////////////////////////////////////////////////////////
                                CONFIG
  //////////////////////////////////////////////////////////////*/

  app.get('/config', async (_request, reply) =>
    reply.send({
      chainId: config.CHAIN_ID,
      token: config.TOKEN_ADDRESS,
      timelock: config.TIMELOCK_ADDRESS,
      governor: config.GOVERNOR_ADDRESS,
      vesting: config.VESTING_ADDRESS,
      distributor: config.DISTRIBUTOR_ADDRESS,
      vault: config.VAULT_ADDRESS,
    }),
  );

  /** Live token stats, read from chain rather than indexed. They change rarely and are the numbers
   *  where showing a stale value is most obviously wrong. */
  app.get('/token', async (_request, reply) => {
    const [name, symbol, decimals, totalSupply, cap, remainingMintable, mintingFinished] =
      await Promise.all([
        publicClient.readContract({address: config.TOKEN_ADDRESS, abi: tokenAbi, functionName: 'name'}),
        publicClient.readContract({address: config.TOKEN_ADDRESS, abi: tokenAbi, functionName: 'symbol'}),
        publicClient.readContract({address: config.TOKEN_ADDRESS, abi: tokenAbi, functionName: 'decimals'}),
        publicClient.readContract({
          address: config.TOKEN_ADDRESS,
          abi: tokenAbi,
          functionName: 'totalSupply',
        }),
        publicClient.readContract({address: config.TOKEN_ADDRESS, abi: tokenAbi, functionName: 'cap'}),
        publicClient.readContract({
          address: config.TOKEN_ADDRESS,
          abi: tokenAbi,
          functionName: 'remainingMintable',
        }),
        publicClient.readContract({
          address: config.TOKEN_ADDRESS,
          abi: tokenAbi,
          functionName: 'mintingFinished',
        }),
      ]);

    return reply.send({
      address: config.TOKEN_ADDRESS,
      name,
      symbol,
      decimals,
      totalSupply: totalSupply.toString(),
      cap: cap.toString(),
      remainingMintable: remainingMintable.toString(),
      mintingFinished,
    });
  });

  /*//////////////////////////////////////////////////////////////
                                AIRDROP
  //////////////////////////////////////////////////////////////*/

  /**
   * Build an airdrop tree and return the root to publish on-chain.
   *
   * Privileged: this decides who receives tokens. Returns 401 when no admin key is configured,
   * rather than silently running unauthenticated.
   */
  app.post('/airdrop/build', async (request, reply) => {
    if (!requireAdmin(request)) {
      return reply.status(401).send({error: 'UNAUTHORIZED'});
    }

    const schema = z.object({
      deadline: z.coerce.number().int().positive(),
      entries: z
        .array(z.object({address: addressParam, amount: z.string().regex(/^\d+$/)}))
        .min(1)
        .max(100_000),
    });

    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({error: 'INVALID_BODY', issues: parsed.error.issues});
    }

    // Indices are assigned here, densely from zero. They address bits in the on-chain claim bitmap,
    // so they must be dense and must never be reassigned once a root is published.
    const entries: AirdropEntry[] = parsed.data.entries.map((entry, index) => ({
      index,
      address: entry.address.toLowerCase() as `0x${string}`,
      amount: BigInt(entry.amount),
    }));

    let tree: AirdropTree;
    try {
      tree = new AirdropTree(entries);
    } catch (error) {
      return reply
        .status(400)
        .send({error: 'INVALID_ENTRIES', message: (error as Error).message});
    }

    await prisma.$transaction(async (tx) => {
      // Rebuilding replaces the list wholesale. Merging would leave stale entries that no longer
      // match the published root.
      await tx.airdropEntry.deleteMany();
      await tx.airdropEntry.createMany({
        data: entries.map((entry) => ({
          index: entry.index,
          address: entry.address,
          amount: entry.amount.toString(),
        })),
      });

      await tx.airdropRoot.create({
        data: {
          root: tree.root,
          entryCount: tree.size,
          totalAmount: tree.totalAmount.toString(),
          deadline: new Date(parsed.data.deadline * 1000),
        },
      });
    });

    return reply.status(201).send({
      root: tree.root,
      entryCount: tree.size,
      totalAmount: tree.totalAmount.toString(),
      nextStep: 'Deploy MerkleDistributor with this root, then fund it with totalAmount',
    });
  });

  /**
   * Claim data for one wallet.
   *
   * A 404 means "no allocation", which the UI renders as an ineligible state rather than an error.
   * The on-chain `isClaimed` flag is authoritative over the indexed `claimedAt`, since the indexer
   * may lag by a confirmation window.
   */
  app.get('/airdrop/claim/:address', async (request, reply) => {
    const {address} = request.params as {address: string};
    const normalised = address.toLowerCase();

    const entry = await prisma.airdropEntry.findUnique({where: {address: normalised}});
    if (!entry) {
      return reply.status(404).send({error: 'NOT_ELIGIBLE'});
    }

    const tree = await loadAirdropTree();
    if (!tree) {
      return reply.status(404).send({error: 'NO_AIRDROP_CONFIGURED'});
    }

    const proof = tree.proofFor(entry.index);
    if (!proof) {
      return reply.status(404).send({error: 'NOT_ELIGIBLE'});
    }

    const [claimedOnChain, deadline] = await Promise.all([
      publicClient.readContract({
        address: config.DISTRIBUTOR_ADDRESS,
        abi: distributorAbi,
        functionName: 'isClaimed',
        args: [BigInt(entry.index)],
      }),
      publicClient.readContract({
        address: config.DISTRIBUTOR_ADDRESS,
        abi: distributorAbi,
        functionName: 'claimDeadline',
      }),
    ]);

    return reply.send({
      index: entry.index,
      address: entry.address,
      amount: entry.amount,
      proof,
      root: tree.root,
      claimed: claimedOnChain,
      claimedAt: entry.claimedAt,
      deadline: Number(deadline),
      expired: Date.now() / 1000 > Number(deadline),
    });
  });

  /** Airdrop progress, for a public dashboard. */
  app.get('/airdrop/stats', async (_request, reply) => {
    const [entryCount, claimedCount, root] = await Promise.all([
      prisma.airdropEntry.count(),
      prisma.airdropEntry.count({where: {claimedAt: {not: null}}}),
      prisma.airdropRoot.findFirst({orderBy: {createdAt: 'desc'}}),
    ]);

    const [onChainClaimed, onChainCount, onChainRoot] = await Promise.all([
      publicClient.readContract({
        address: config.DISTRIBUTOR_ADDRESS,
        abi: distributorAbi,
        functionName: 'totalClaimed',
      }),
      publicClient.readContract({
        address: config.DISTRIBUTOR_ADDRESS,
        abi: distributorAbi,
        functionName: 'claimCount',
      }),
      publicClient.readContract({
        address: config.DISTRIBUTOR_ADDRESS,
        abi: distributorAbi,
        functionName: 'merkleRoot',
      }),
    ]);

    return reply.send({
      entryCount,
      claimedCount,
      totalAllocated: root?.totalAmount ?? '0',
      totalClaimed: onChainClaimed.toString(),
      onChainClaimCount: Number(onChainCount),
      // A mismatch here means the database and the deployed contract disagree about who is
      // eligible, so every proof served would fail. Surfaced rather than hidden.
      rootMatchesChain: root ? root.root.toLowerCase() === onChainRoot.toLowerCase() : null,
    });
  });

  /*//////////////////////////////////////////////////////////////
                                VESTING
  //////////////////////////////////////////////////////////////*/

  /** A beneficiary's schedules, with live releasable amounts read from chain. */
  app.get('/vesting/:address', async (request, reply) => {
    const {address} = request.params as {address: string};
    const beneficiary = address.toLowerCase();

    const schedules = await prisma.vestingSchedule.findMany({
      where: {beneficiary},
      include: {releases: {orderBy: {blockTime: 'desc'}}},
      orderBy: {startTime: 'asc'},
    });

    // Releasable is read live rather than computed here. Reimplementing the vesting curve in the
    // API would eventually disagree with the contract and show a claimable amount that reverts.
    const releasable = await Promise.all(
      schedules.map((schedule) =>
        publicClient
          .readContract({
            address: config.VESTING_ADDRESS,
            abi: vestingAbi,
            functionName: 'releasableAmount',
            args: [BigInt(schedule.id)],
          })
          .catch(() => 0n),
      ),
    );

    return reply.send({
      beneficiary,
      schedules: schedules.map((schedule, i) => ({
        ...schedule,
        releasable: releasable[i]!.toString(),
      })),
      totalReleasable: releasable.reduce((sum, value) => sum + value, 0n).toString(),
    });
  });

  /**
   * Unlock curve for a schedule, sampled for charting.
   *
   * Points come from the contract's own `vestedAt`, so the chart cannot drift from what the
   * contract will actually pay out.
   */
  app.get('/vesting/:id/curve', async (request, reply) => {
    const {id} = request.params as {id: string};

    const schedule = await prisma.vestingSchedule.findUnique({where: {id}});
    if (!schedule) {
      return reply.status(404).send({error: 'NOT_FOUND'});
    }

    const start = Math.floor(schedule.startTime.getTime() / 1000);
    const end = start + schedule.durationSeconds;
    const POINTS = 60;

    const timestamps = Array.from({length: POINTS + 1}, (_unused, i) =>
      BigInt(start + Math.floor(((end - start) * i) / POINTS)),
    );

    const vested = await Promise.all(
      timestamps.map((timestamp) =>
        publicClient
          .readContract({
            address: config.VESTING_ADDRESS,
            abi: vestingAbi,
            functionName: 'vestedAt',
            args: [BigInt(id), timestamp],
          })
          .catch(() => 0n),
      ),
    );

    return reply.send({
      scheduleId: id,
      total: schedule.total,
      points: timestamps.map((timestamp, i) => ({
        timestamp: Number(timestamp),
        vested: vested[i]!.toString(),
      })),
    });
  });

  /*//////////////////////////////////////////////////////////////
                                STAKING
  //////////////////////////////////////////////////////////////*/

  app.get('/staking/stats', async (_request, reply) => {
    const [totalAssets, totalShares, pricePerShare, aprBps, lockedRewards] = await Promise.all([
      publicClient.readContract({address: config.VAULT_ADDRESS, abi: vaultAbi, functionName: 'totalAssets'}),
      publicClient.readContract({address: config.VAULT_ADDRESS, abi: vaultAbi, functionName: 'totalSupply'}),
      publicClient.readContract({
        address: config.VAULT_ADDRESS,
        abi: vaultAbi,
        functionName: 'pricePerShare',
      }),
      publicClient.readContract({address: config.VAULT_ADDRESS, abi: vaultAbi, functionName: 'currentApr'}),
      publicClient.readContract({
        address: config.VAULT_ADDRESS,
        abi: vaultAbi,
        functionName: 'lockedRewards',
      }),
    ]);

    const stakerCount = await prisma.stakePosition.count({where: {shares: {not: '0'}}});

    return reply.send({
      totalAssets: totalAssets.toString(),
      totalShares: totalShares.toString(),
      pricePerShare: pricePerShare.toString(),
      aprBps: Number(aprBps),
      lockedRewards: lockedRewards.toString(),
      stakerCount,
    });
  });

  app.get('/staking/:address', async (request, reply) => {
    const {address} = request.params as {address: string};
    const staker = address.toLowerCase() as `0x${string}`;

    const [shares, cooldownRemaining, position, events] = await Promise.all([
      publicClient.readContract({
        address: config.VAULT_ADDRESS,
        abi: vaultAbi,
        functionName: 'balanceOf',
        args: [staker],
      }),
      publicClient.readContract({
        address: config.VAULT_ADDRESS,
        abi: vaultAbi,
        functionName: 'cooldownRemaining',
        args: [staker],
      }),
      prisma.stakePosition.findUnique({where: {address: staker}}),
      prisma.stakeEvent.findMany({
        where: {address: staker},
        orderBy: {blockTime: 'desc'},
        take: 50,
      }),
    ]);

    const assets =
      shares === 0n
        ? 0n
        : await publicClient.readContract({
            address: config.VAULT_ADDRESS,
            abi: vaultAbi,
            functionName: 'convertToAssets',
            args: [shares],
          });

    // Unrealised profit is current value minus what was actually put in, which is why the indexer
    // tracks `netDeposited` rather than trying to infer it from balances.
    const netDeposited = BigInt(position?.netDeposited ?? '0');

    return reply.send({
      address: staker,
      shares: shares.toString(),
      assets: assets.toString(),
      netDeposited: netDeposited.toString(),
      unrealisedGain: (assets - netDeposited).toString(),
      cooldownRemaining: Number(cooldownRemaining),
      history: events,
    });
  });

  /** Share price over time, for the yield chart. */
  app.get('/staking/history', async (_request, reply) => {
    const snapshots = await prisma.vaultSnapshot.findMany({
      orderBy: {capturedAt: 'asc'},
      take: 500,
    });

    return reply.send({snapshots});
  });

  /*//////////////////////////////////////////////////////////////
                              GOVERNANCE
  //////////////////////////////////////////////////////////////*/

  app.get('/proposals', async (request, reply) => {
    const schema = z.object({
      state: z.enum(PROPOSAL_STATES).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      cursor: z.string().optional(),
    });

    const parsed = schema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({error: 'INVALID_QUERY', issues: parsed.error.issues});
    }

    const {state, limit, cursor} = parsed.data;

    const proposals = await prisma.proposal.findMany({
      where: state ? {state} : {},
      orderBy: {createdAt: 'desc'},
      take: limit + 1,
      ...(cursor ? {cursor: {id: cursor}, skip: 1} : {}),
    });

    const hasMore = proposals.length > limit;
    const page = hasMore ? proposals.slice(0, limit) : proposals;

    return reply.send({
      proposals: page,
      nextCursor: hasMore ? page[page.length - 1]?.id : null,
    });
  });

  /**
   * One proposal, with its live state and quorum read from chain.
   *
   * State transitions (Active to Succeeded to Queued) happen with the passage of time rather than
   * by emitting an event, so an indexed state goes stale on its own. Reading it live is the only
   * way to be right.
   */
  app.get('/proposals/:id', async (request, reply) => {
    const {id} = request.params as {id: string};

    const proposal = await prisma.proposal.findUnique({
      where: {id},
      include: {votes: {orderBy: {blockTime: 'desc'}}},
    });

    if (!proposal) {
      return reply.status(404).send({error: 'NOT_FOUND'});
    }

    const [stateIndex, votes, quorum] = await Promise.all([
      publicClient
        .readContract({
          address: config.GOVERNOR_ADDRESS,
          abi: governorAbi,
          functionName: 'state',
          args: [BigInt(id)],
        })
        .catch(() => null),
      publicClient
        .readContract({
          address: config.GOVERNOR_ADDRESS,
          abi: governorAbi,
          functionName: 'proposalVotes',
          args: [BigInt(id)],
        })
        .catch(() => null),
      publicClient
        .readContract({
          address: config.GOVERNOR_ADDRESS,
          abi: governorAbi,
          functionName: 'quorum',
          args: [BigInt(Math.floor(proposal.voteStart.getTime() / 1000))],
        })
        .catch(() => null),
    ]);

    const liveState = stateIndex === null ? proposal.state : PROPOSAL_STATES[Number(stateIndex)];

    return reply.send({
      proposal: {
        ...proposal,
        state: liveState,
        againstVotes: votes ? votes[0].toString() : proposal.againstVotes,
        forVotes: votes ? votes[1].toString() : proposal.forVotes,
        abstainVotes: votes ? votes[2].toString() : proposal.abstainVotes,
        quorum: quorum?.toString() ?? null,
        quorumReached:
          quorum !== null && votes !== null ? votes[1] + votes[2] >= quorum : null,
      },
    });
  });

  /** Voting power and delegation for one wallet. */
  app.get('/voting-power/:address', async (request, reply) => {
    const {address} = request.params as {address: string};
    const account = address.toLowerCase() as `0x${string}`;

    const [votes, delegatedTo, balance, threshold] = await Promise.all([
      publicClient.readContract({
        address: config.TOKEN_ADDRESS,
        abi: tokenAbi,
        functionName: 'getVotes',
        args: [account],
      }),
      publicClient.readContract({
        address: config.TOKEN_ADDRESS,
        abi: tokenAbi,
        functionName: 'delegates',
        args: [account],
      }),
      publicClient.readContract({
        address: config.TOKEN_ADDRESS,
        abi: tokenAbi,
        functionName: 'balanceOf',
        args: [account],
      }),
      publicClient.readContract({
        address: config.GOVERNOR_ADDRESS,
        abi: governorAbi,
        functionName: 'proposalThreshold',
      }),
    ]);

    const zero = '0x0000000000000000000000000000000000000000';

    return reply.send({
      address: account,
      balance: balance.toString(),
      votes: votes.toString(),
      delegatedTo: delegatedTo.toLowerCase() === zero ? null : delegatedTo.toLowerCase(),
      // The single most common source of confusion with ERC20Votes: holding is not voting.
      hasDelegated: delegatedTo.toLowerCase() !== zero,
      canPropose: votes >= threshold,
      proposalThreshold: threshold.toString(),
    });
  });

  /** Top delegates by voting power. */
  app.get('/delegates', async (_request, reply) => {
    const delegates = await prisma.votingPower.findMany({
      where: {votes: {not: '0'}},
      orderBy: {votes: 'desc'},
      take: 100,
    });

    return reply.send({delegates});
  });
}
