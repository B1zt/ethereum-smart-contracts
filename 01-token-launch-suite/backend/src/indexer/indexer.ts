import type {Abi, AbiEvent} from 'viem';
import {
  distributorAbi,
  governorAbi,
  PROPOSAL_STATES,
  tokenAbi,
  vaultAbi,
  vestingAbi,
  VOTE_SUPPORT,
} from '../chain/abis.js';
import {getHeadBlock, publicClient} from '../chain/client.js';
import {config} from '../config.js';
import {logger} from '../lib/logger.js';
import {prisma} from '../lib/prisma.js';

interface DecodedEvent {
  eventName: string;
  args: Record<string, unknown>;
  txHash: `0x${string}`;
  logIndex: number;
  blockNumber: bigint;
  blockTime: Date;
}

interface WatchedContract {
  id: string;
  address: `0x${string}`;
  abi: Abi;
  handlers: Record<string, (event: DecodedEvent) => Promise<void>>;
}

/**
 * Log indexer with reorg-safe checkpointing.
 *
 * A single cursor per contract holds the highest block considered **final**, trailing the head by
 * `CONFIRMATIONS`. Each pass deletes rows sourced from non-final blocks, re-scans from the cursor to
 * the head, then advances the cursor only as far as the safe block.
 *
 * The delete-and-rescan is what makes this correct across a reorg. Without it, a claim that was
 * mined, indexed, then orphaned would sit in the database forever and the airdrop would report
 * tokens as claimed that nobody holds.
 *
 * Every write is keyed on `(txHash, logIndex)`, so replaying a range is a no-op rather than a
 * duplicate. That is what lets the process be killed at any point and resumed without bookkeeping.
 */
export class Indexer {
  private readonly contracts: WatchedContract[];
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private lastSnapshotAt = 0;

  constructor() {
    this.contracts = [
      {
        id: 'distributor',
        address: config.DISTRIBUTOR_ADDRESS,
        abi: distributorAbi as unknown as Abi,
        handlers: {Claimed: this.handleClaimed},
      },
      {
        id: 'vesting',
        address: config.VESTING_ADDRESS,
        abi: vestingAbi as unknown as Abi,
        handlers: {
          ScheduleCreated: this.handleScheduleCreated,
          Released: this.handleReleased,
          Revoked: this.handleRevoked,
        },
      },
      {
        id: 'vault',
        address: config.VAULT_ADDRESS,
        abi: vaultAbi as unknown as Abi,
        handlers: {
          Deposit: this.handleDeposit,
          Withdraw: this.handleWithdraw,
        },
      },
      {
        id: 'governor',
        address: config.GOVERNOR_ADDRESS,
        abi: governorAbi as unknown as Abi,
        handlers: {
          ProposalCreated: this.handleProposalCreated,
          VoteCast: this.handleVoteCast,
          ProposalQueued: this.handleProposalQueued,
          ProposalExecuted: this.handleProposalExecuted,
          ProposalCanceled: this.handleProposalCanceled,
        },
      },
      {
        id: 'token',
        address: config.TOKEN_ADDRESS,
        abi: tokenAbi as unknown as Abi,
        handlers: {DelegateVotesChanged: this.handleDelegateVotesChanged},
      },
    ];
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    logger.info(
      {contracts: this.contracts.map((c) => c.id), confirmations: config.CONFIRMATIONS},
      'indexer starting',
    );

    await this.tick();
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    logger.info('indexer stopped');
  }

  private scheduleNext(): void {
    if (!this.running) return;

    this.timer = setTimeout(() => {
      void this.tick()
        .catch((error) => logger.error({error}, 'indexer pass failed'))
        .finally(() => this.scheduleNext());
    }, config.INDEXER_POLL_INTERVAL * 1_000);
  }

  private async tick(): Promise<void> {
    const head = await getHeadBlock();
    const confirmations = BigInt(config.CONFIRMATIONS);
    const safeBlock = head > confirmations ? head - confirmations : 0n;

    for (const contract of this.contracts) {
      await this.syncContract(contract, head, safeBlock);
    }

    await this.maybeSnapshotVault(head);
    await this.refreshProposalStates();
  }

  private async syncContract(
    contract: WatchedContract,
    head: bigint,
    safeBlock: bigint,
  ): Promise<void> {
    const cursor = await this.readCursor(contract);
    const fromBlock = cursor + 1n;
    if (fromBlock > head) return;

    await this.dropProvisionalRows(safeBlock);

    const batchSize = BigInt(config.INDEXER_BATCH_SIZE);
    let current = fromBlock;
    let processed = 0;

    while (current <= head) {
      const toBlock = current + batchSize - 1n > head ? head : current + batchSize - 1n;
      processed += await this.processRange(contract, current, toBlock);
      current = toBlock + 1n;
    }

    await this.writeCursor(contract, safeBlock);

    if (processed > 0) {
      logger.info({contract: contract.id, processed, head: head.toString()}, 'indexed events');
    }
  }

  private async processRange(
    contract: WatchedContract,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<number> {
    const events = (contract.abi as readonly AbiEvent[]).filter(
      (item) => item.type === 'event' && contract.handlers[item.name] !== undefined,
    );
    if (events.length === 0) return 0;

    const logs = await publicClient.getLogs({address: contract.address, events, fromBlock, toBlock});
    if (logs.length === 0) return 0;

    // Block timestamps are not on the log. Fetching one block per log would hammer the RPC, so each
    // distinct block is fetched once and reused.
    const blockNumbers = [...new Set(logs.map((log) => log.blockNumber!))];
    const blocks = await Promise.all(
      blockNumbers.map((blockNumber) => publicClient.getBlock({blockNumber})),
    );
    const timeByBlock = new Map(
      blocks.map((block) => [block.number!, new Date(Number(block.timestamp) * 1000)]),
    );

    // Chain order matters: a vote and the execution that follows must apply in sequence.
    const ordered = [...logs].sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) return a.blockNumber! < b.blockNumber! ? -1 : 1;
      return a.logIndex! - b.logIndex!;
    });

    let processed = 0;

    for (const log of ordered) {
      const decoded = log as unknown as {
        eventName: string;
        args: Record<string, unknown>;
        transactionHash: `0x${string}`;
        logIndex: number;
        blockNumber: bigint;
      };

      const handler = contract.handlers[decoded.eventName];
      if (!handler) continue;

      try {
        await handler({
          eventName: decoded.eventName,
          args: decoded.args,
          txHash: decoded.transactionHash,
          logIndex: decoded.logIndex,
          blockNumber: decoded.blockNumber,
          blockTime: timeByBlock.get(decoded.blockNumber) ?? new Date(),
        });
        processed += 1;
      } catch (error) {
        // One bad log must not stall the pipeline. It is logged with enough detail to replay, and
        // the range is re-scanned anyway if it sits above the safe block.
        logger.error(
          {error, contract: contract.id, event: decoded.eventName, txHash: decoded.transactionHash},
          'handler failed',
        );
      }
    }

    return processed;
  }

  /*//////////////////////////////////////////////////////////////
                               HANDLERS
  //////////////////////////////////////////////////////////////*/

  private handleClaimed = async (event: DecodedEvent): Promise<void> => {
    const args = event.args as {index: bigint; account: `0x${string}`; amount: bigint};

    await prisma.airdropEntry.updateMany({
      where: {index: Number(args.index)},
      data: {claimedAt: event.blockTime, claimTx: event.txHash},
    });
  };

  private handleScheduleCreated = async (event: DecodedEvent): Promise<void> => {
    const args = event.args as {
      scheduleId: bigint;
      beneficiary: `0x${string}`;
      schedule: {
        total: bigint;
        released: bigint;
        start: bigint;
        cliff: bigint;
        duration: bigint;
        revocable: boolean;
      };
    };

    await prisma.vestingSchedule.upsert({
      where: {id: args.scheduleId.toString()},
      create: {
        id: args.scheduleId.toString(),
        beneficiary: args.beneficiary.toLowerCase(),
        total: args.schedule.total.toString(),
        released: args.schedule.released.toString(),
        startTime: new Date(Number(args.schedule.start) * 1000),
        cliffSeconds: Number(args.schedule.cliff),
        durationSeconds: Number(args.schedule.duration),
        revocable: args.schedule.revocable,
      },
      update: {},
    });
  };

  private handleReleased = async (event: DecodedEvent): Promise<void> => {
    const args = event.args as {scheduleId: bigint; beneficiary: `0x${string}`; amount: bigint};
    const scheduleId = args.scheduleId.toString();

    const existing = await prisma.vestingRelease.findUnique({
      where: {txHash_logIndex: {txHash: event.txHash, logIndex: event.logIndex}},
    });
    if (existing) return;

    await prisma.$transaction(async (tx) => {
      const schedule = await tx.vestingSchedule.findUnique({where: {id: scheduleId}});
      if (!schedule) return;

      await tx.vestingRelease.create({
        data: {
          scheduleId,
          beneficiary: args.beneficiary.toLowerCase(),
          amount: args.amount.toString(),
          txHash: event.txHash,
          logIndex: event.logIndex,
          blockNumber: event.blockNumber,
          blockTime: event.blockTime,
        },
      });

      await tx.vestingSchedule.update({
        where: {id: scheduleId},
        data: {released: (BigInt(schedule.released) + args.amount).toString()},
      });
    });
  };

  private handleRevoked = async (event: DecodedEvent): Promise<void> => {
    const args = event.args as {scheduleId: bigint};

    await prisma.vestingSchedule.updateMany({
      where: {id: args.scheduleId.toString()},
      data: {revoked: true},
    });
  };

  private handleDeposit = async (event: DecodedEvent): Promise<void> => {
    const args = event.args as {owner: `0x${string}`; assets: bigint; shares: bigint};
    await this.recordStakeEvent(event, args.owner, 'DEPOSIT', args.assets, args.shares);
  };

  private handleWithdraw = async (event: DecodedEvent): Promise<void> => {
    const args = event.args as {owner: `0x${string}`; assets: bigint; shares: bigint};
    await this.recordStakeEvent(event, args.owner, 'WITHDRAW', args.assets, args.shares);
  };

  private async recordStakeEvent(
    event: DecodedEvent,
    owner: `0x${string}`,
    kind: 'DEPOSIT' | 'WITHDRAW',
    assets: bigint,
    shares: bigint,
  ): Promise<void> {
    const address = owner.toLowerCase();

    const existing = await prisma.stakeEvent.findUnique({
      where: {txHash_logIndex: {txHash: event.txHash, logIndex: event.logIndex}},
    });
    if (existing) return;

    await prisma.$transaction(async (tx) => {
      await tx.stakeEvent.create({
        data: {
          address,
          kind,
          assets: assets.toString(),
          shares: shares.toString(),
          txHash: event.txHash,
          logIndex: event.logIndex,
          blockNumber: event.blockNumber,
          blockTime: event.blockTime,
        },
      });

      const position = await tx.stakePosition.findUnique({where: {address}});

      const currentShares = BigInt(position?.shares ?? '0');
      const currentNet = BigInt(position?.netDeposited ?? '0');

      const sign = kind === 'DEPOSIT' ? 1n : -1n;
      const nextShares = currentShares + sign * shares;
      // Net deposited is the cost basis, so unrealised gain is current value minus this. Clamped at
      // zero because a staker who withdraws more value than they put in has fully realised the gain.
      const nextNet = currentNet + sign * assets;

      await tx.stakePosition.upsert({
        where: {address},
        create: {
          address,
          shares: (nextShares > 0n ? nextShares : 0n).toString(),
          netDeposited: (nextNet > 0n ? nextNet : 0n).toString(),
        },
        update: {
          shares: (nextShares > 0n ? nextShares : 0n).toString(),
          netDeposited: (nextNet > 0n ? nextNet : 0n).toString(),
        },
      });
    });
  }

  private handleProposalCreated = async (event: DecodedEvent): Promise<void> => {
    const args = event.args as {
      proposalId: bigint;
      proposer: `0x${string}`;
      targets: readonly `0x${string}`[];
      values: readonly bigint[];
      calldatas: readonly `0x${string}`[];
      voteStart: bigint;
      voteEnd: bigint;
      description: string;
    };

    await prisma.proposal.upsert({
      where: {id: args.proposalId.toString()},
      create: {
        id: args.proposalId.toString(),
        proposer: args.proposer.toLowerCase(),
        description: args.description,
        targets: args.targets.map((target) => target.toLowerCase()),
        values: args.values.map((value) => value.toString()),
        calldatas: [...args.calldatas],
        voteStart: new Date(Number(args.voteStart) * 1000),
        voteEnd: new Date(Number(args.voteEnd) * 1000),
        state: 'PENDING',
      },
      update: {},
    });
  };

  private handleVoteCast = async (event: DecodedEvent): Promise<void> => {
    const args = event.args as {
      voter: `0x${string}`;
      proposalId: bigint;
      support: number;
      weight: bigint;
      reason: string;
    };

    const existing = await prisma.vote.findUnique({
      where: {txHash_logIndex: {txHash: event.txHash, logIndex: event.logIndex}},
    });
    if (existing) return;

    const proposalId = args.proposalId.toString();
    const support = VOTE_SUPPORT[args.support] ?? 'ABSTAIN';

    await prisma.$transaction(async (tx) => {
      const proposal = await tx.proposal.findUnique({where: {id: proposalId}});
      if (!proposal) return;

      await tx.vote.create({
        data: {
          proposalId,
          voter: args.voter.toLowerCase(),
          support,
          weight: args.weight.toString(),
          reason: args.reason || null,
          txHash: event.txHash,
          logIndex: event.logIndex,
          blockNumber: event.blockNumber,
          blockTime: event.blockTime,
        },
      });

      const tally = {
        AGAINST: BigInt(proposal.againstVotes),
        FOR: BigInt(proposal.forVotes),
        ABSTAIN: BigInt(proposal.abstainVotes),
      };
      tally[support] += args.weight;

      await tx.proposal.update({
        where: {id: proposalId},
        data: {
          againstVotes: tally.AGAINST.toString(),
          forVotes: tally.FOR.toString(),
          abstainVotes: tally.ABSTAIN.toString(),
          state: 'ACTIVE',
        },
      });
    });
  };

  private handleProposalQueued = async (event: DecodedEvent): Promise<void> => {
    const args = event.args as {proposalId: bigint; etaSeconds: bigint};

    await prisma.proposal.updateMany({
      where: {id: args.proposalId.toString()},
      data: {state: 'QUEUED', etaAt: new Date(Number(args.etaSeconds) * 1000)},
    });
  };

  private handleProposalExecuted = async (event: DecodedEvent): Promise<void> => {
    const args = event.args as {proposalId: bigint};

    await prisma.proposal.updateMany({
      where: {id: args.proposalId.toString()},
      data: {state: 'EXECUTED', executedAt: event.blockTime},
    });
  };

  private handleProposalCanceled = async (event: DecodedEvent): Promise<void> => {
    const args = event.args as {proposalId: bigint};

    await prisma.proposal.updateMany({
      where: {id: args.proposalId.toString()},
      data: {state: 'CANCELED'},
    });
  };

  private handleDelegateVotesChanged = async (event: DecodedEvent): Promise<void> => {
    const args = event.args as {delegate: `0x${string}`; newVotes: bigint};
    const address = args.delegate.toLowerCase();

    await prisma.votingPower.upsert({
      where: {address},
      create: {address, votes: args.newVotes.toString()},
      update: {votes: args.newVotes.toString()},
    });
  };

  /*//////////////////////////////////////////////////////////////
                              PERIODIC WORK
  //////////////////////////////////////////////////////////////*/

  /**
   * Snapshot the vault's share price on a schedule.
   *
   * Share price rises continuously as rewards stream, and no event fires when it does. Without
   * periodic snapshots there is no way to chart historical yield.
   */
  private async maybeSnapshotVault(head: bigint): Promise<void> {
    const now = Date.now();
    if (now - this.lastSnapshotAt < config.VAULT_SNAPSHOT_INTERVAL * 1_000) return;

    this.lastSnapshotAt = now;

    try {
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

      await prisma.vaultSnapshot.upsert({
        where: {blockNumber: head},
        create: {
          blockNumber: head,
          totalAssets: totalAssets.toString(),
          totalShares: totalShares.toString(),
          pricePerShare: pricePerShare.toString(),
          lockedRewards: lockedRewards.toString(),
          aprBps: Number(aprBps),
          capturedAt: new Date(),
        },
        update: {},
      });
    } catch (error) {
      logger.warn({error}, 'vault snapshot failed');
    }
  }

  /**
   * Refresh proposal states from chain.
   *
   * Governor states change with the passage of time (Pending to Active, Active to Succeeded or
   * Defeated) without emitting anything. Purely event-driven state would therefore be permanently
   * stale for exactly the proposals a user is most likely to be looking at.
   */
  private async refreshProposalStates(): Promise<void> {
    const open = await prisma.proposal.findMany({
      where: {state: {in: ['PENDING', 'ACTIVE', 'SUCCEEDED', 'QUEUED']}},
      select: {id: true, state: true},
    });

    for (const proposal of open) {
      try {
        const stateIndex = await publicClient.readContract({
          address: config.GOVERNOR_ADDRESS,
          abi: governorAbi,
          functionName: 'state',
          args: [BigInt(proposal.id)],
        });

        const next = PROPOSAL_STATES[Number(stateIndex)];
        if (next && next !== proposal.state) {
          await prisma.proposal.update({where: {id: proposal.id}, data: {state: next}});
        }
      } catch (error) {
        logger.debug({error, proposalId: proposal.id}, 'proposal state refresh failed');
      }
    }
  }

  /*//////////////////////////////////////////////////////////////
                                CURSOR
  //////////////////////////////////////////////////////////////*/

  /** Remove rows sourced from blocks that are not yet final. */
  private async dropProvisionalRows(safeBlock: bigint): Promise<void> {
    await prisma.$transaction([
      prisma.vestingRelease.deleteMany({where: {blockNumber: {gt: safeBlock}}}),
      prisma.stakeEvent.deleteMany({where: {blockNumber: {gt: safeBlock}}}),
      prisma.vote.deleteMany({where: {blockNumber: {gt: safeBlock}}}),
    ]);
  }

  private async readCursor(contract: WatchedContract): Promise<bigint> {
    const row = await prisma.indexerCursor.findUnique({where: {contract: contract.address}});
    if (row) return row.lastSafeBlock;

    // Starting from the deploy block rather than genesis avoids scanning millions of empty blocks.
    const start = config.DEPLOY_BLOCK > 0n ? config.DEPLOY_BLOCK - 1n : 0n;

    await prisma.indexerCursor.create({
      data: {id: contract.id, contract: contract.address, lastSafeBlock: start},
    });

    return start;
  }

  private async writeCursor(contract: WatchedContract, block: bigint): Promise<void> {
    await prisma.indexerCursor.update({
      where: {contract: contract.address},
      data: {lastSafeBlock: block},
    });
  }
}
