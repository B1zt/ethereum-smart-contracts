import type {Abi, AbiEvent} from 'viem';
import {auctionAbi, collectionAbi, marketplaceAbi} from '../chain/abis.js';
import {getHeadBlock, publicClient} from '../chain/client.js';
import {config} from '../config.js';
import {logger} from '../lib/logger.js';
import {prisma} from '../lib/prisma.js';
import {
  handleAuctionCancelled,
  handleAuctionCreated,
  handleAuctionSettled,
  handleBidPlaced,
  handleNonceIncremented,
  handleOrderCancelled,
  handleOrderFilled,
  handleTransfer,
  sweepExpiredOrders,
  type DecodedEvent,
} from './handlers.js';

interface WatchedContract {
  id: string;
  address: `0x${string}`;
  abi: Abi;
  handlers: Record<string, (event: DecodedEvent) => Promise<void>>;
}

function buildWatchList(): WatchedContract[] {
  return [
    {
      id: 'marketplace',
      address: config.MARKETPLACE_ADDRESS,
      abi: marketplaceAbi as unknown as Abi,
      handlers: {
        OrderFilled: handleOrderFilled,
        OrderCancelled: handleOrderCancelled,
        NonceIncremented: handleNonceIncremented,
      },
    },
    {
      id: 'auction',
      address: config.AUCTION_ADDRESS,
      abi: auctionAbi as unknown as Abi,
      handlers: {
        AuctionCreated: handleAuctionCreated,
        BidPlaced: handleBidPlaced,
        AuctionSettled: handleAuctionSettled,
        AuctionCancelled: handleAuctionCancelled,
      },
    },
    {
      id: 'collection',
      address: config.COLLECTION_ADDRESS,
      abi: collectionAbi as unknown as Abi,
      handlers: {
        Transfer: (event) => handleTransfer(event, config.COLLECTION_ADDRESS),
      },
    },
  ];
}

/**
 * Log indexer with reorg-safe checkpointing.
 *
 * The model is a single cursor per contract holding the highest block considered **final**, which
 * trails the chain head by `CONFIRMATIONS`. Each pass:
 *
 *   1. Delete every indexed row above the new safe block. Those came from blocks that could still
 *      be reorganised out, so they are treated as provisional and rebuilt from scratch.
 *   2. Re-scan from the cursor to the current head, which re-inserts the still-valid provisional
 *      rows along with anything new.
 *   3. Advance the cursor only as far as the safe block.
 *
 * The delete-and-rescan in step 1 is what makes this correct across a reorg. Without it, a trade
 * that was mined, indexed, then orphaned would sit in the database forever, and the collection's
 * volume figure would include a sale that never happened.
 *
 * Every write is keyed on `(txHash, logIndex)`, so re-scanning the same range is a no-op rather
 * than a duplicate. That is what allows the process to be killed at any point and resumed without
 * bookkeeping about where it stopped.
 */
export class Indexer {
  private readonly contracts = buildWatchList();
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    logger.info(
      {
        contracts: this.contracts.map((contract) => contract.id),
        confirmations: config.CONFIRMATIONS,
        pollInterval: config.INDEXER_POLL_INTERVAL,
      },
      'indexer starting',
    );

    await this.tick();
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
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

    const expired = await sweepExpiredOrders();
    if (expired > 0) {
      logger.debug({expired}, 'swept expired orders');
    }
  }

  private async syncContract(
    contract: WatchedContract,
    head: bigint,
    safeBlock: bigint,
  ): Promise<void> {
    const cursor = await this.readCursor(contract);
    const fromBlock = cursor + 1n;

    if (fromBlock > head) return;

    // Step 1: drop provisional rows. Anything above the safe block may have been reorged out.
    await this.dropProvisionalRows(safeBlock);

    // Step 2: scan forward in RPC-sized chunks.
    const batchSize = BigInt(config.INDEXER_BATCH_SIZE);
    let cursorBlock = fromBlock;
    let processed = 0;

    while (cursorBlock <= head) {
      const toBlock = cursorBlock + batchSize - 1n > head ? head : cursorBlock + batchSize - 1n;

      processed += await this.processRange(contract, cursorBlock, toBlock);
      cursorBlock = toBlock + 1n;
    }

    // Step 3: the cursor only ever advances to the safe block, never to the head. Anything above it
    // gets re-scanned next pass, which is exactly what makes reorg recovery automatic.
    await this.writeCursor(contract, safeBlock);

    if (processed > 0) {
      logger.info(
        {contract: contract.id, fromBlock: fromBlock.toString(), head: head.toString(), processed},
        'indexed events',
      );
    }
  }

  private async processRange(
    contract: WatchedContract,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<number> {
    const eventAbis = (contract.abi as readonly AbiEvent[]).filter(
      (item) => item.type === 'event' && contract.handlers[item.name] !== undefined,
    );

    if (eventAbis.length === 0) return 0;

    const logs = await publicClient.getLogs({
      address: contract.address,
      events: eventAbis,
      fromBlock,
      toBlock,
    });

    if (logs.length === 0) return 0;

    // Block timestamps are not on the log, and fetching one block per log would be brutal on the
    // RPC. Fetch each distinct block once and reuse it across every log it contains.
    const blockNumbers = [...new Set(logs.map((log) => log.blockNumber!))];
    const blocks = await Promise.all(
      blockNumbers.map((blockNumber) => publicClient.getBlock({blockNumber})),
    );
    const timeByBlock = new Map(
      blocks.map((block) => [block.number!, new Date(Number(block.timestamp) * 1000)]),
    );

    // Chain order matters: a bid and the settlement that follows it must be applied in sequence.
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

      const event: DecodedEvent = {
        eventName: decoded.eventName,
        args: decoded.args,
        txHash: decoded.transactionHash,
        logIndex: decoded.logIndex,
        blockNumber: decoded.blockNumber,
        blockTime: timeByBlock.get(decoded.blockNumber) ?? new Date(),
      };

      try {
        await handler(event);
        processed += 1;
      } catch (error) {
        // One bad log must not stall the whole pipeline. It is logged with enough detail to replay
        // by hand, and the range will be re-scanned anyway if it sits above the safe block.
        logger.error(
          {error, contract: contract.id, event: decoded.eventName, txHash: decoded.transactionHash},
          'handler failed',
        );
      }
    }

    return processed;
  }

  /** Remove rows sourced from blocks that are not yet final. */
  private async dropProvisionalRows(safeBlock: bigint): Promise<void> {
    await prisma.$transaction([
      prisma.fill.deleteMany({where: {blockNumber: {gt: safeBlock}}}),
      prisma.bid.deleteMany({where: {blockNumber: {gt: safeBlock}}}),
    ]);
  }

  private async readCursor(contract: WatchedContract): Promise<bigint> {
    const row = await prisma.indexerCursor.findUnique({where: {contract: contract.address}});
    if (row) return row.lastSafeBlock;

    // First run. Starting from the deploy block rather than genesis avoids scanning millions of
    // empty blocks on a fresh database.
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
