'use client';

import {useQuery, useQueryClient} from '@tanstack/react-query';
import {use, useEffect, useState} from 'react';
import {useAccount, useWaitForTransactionReceipt, useWriteContract} from 'wagmi';
import {api} from '@/lib/api';
import {auctionAbi, contracts} from '@/lib/contracts';
import {formatCountdown, formatPrice, formatRelativeTime, shortAddress} from '@/lib/format';
import {parseAmount} from '@/lib/format';

export default function AuctionPage({params}: {params: Promise<{id: string}>}) {
  const {id} = use(params);
  const {address} = useAccount();
  const queryClient = useQueryClient();

  const [bidInput, setBidInput] = useState('');
  const [, forceTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => forceTick((value) => value + 1), 1_000);
    return () => clearInterval(timer);
  }, []);

  const {data, isLoading} = useQuery({
    queryKey: ['auction', id],
    queryFn: () => api.auction(id),
    refetchInterval: 5_000,
  });

  const {writeContract, data: hash, isPending, error} = useWriteContract();
  const {isLoading: confirming, isSuccess} = useWaitForTransactionReceipt({hash});

  useEffect(() => {
    if (isSuccess) {
      setBidInput('');
      void queryClient.invalidateQueries({queryKey: ['auction', id]});
    }
  }, [isSuccess, queryClient, id]);

  if (isLoading || !data) {
    return <div className="h-64 animate-pulse rounded-xl bg-neutral-900" />;
  }

  const {auction} = data;
  const countdown = formatCountdown(auction.endTime);
  const ended = countdown === null;
  const isSeller = Boolean(address && address.toLowerCase() === auction.seller.toLowerCase());

  const minimumBid = auction.minimumBid ? BigInt(auction.minimumBid) : BigInt(auction.reservePrice);
  const bidWei = parseAmount(bidInput);
  const bidTooLow = bidWei !== null && bidWei < minimumBid;

  const handleBid = () => {
    if (bidWei === null) return;
    writeContract({
      address: contracts.auction,
      abi: auctionAbi,
      functionName: 'bid',
      args: [BigInt(id), bidWei],
      value: bidWei,
    });
  };

  const handleSettle = () => {
    writeContract({
      address: contracts.auction,
      abi: auctionAbi,
      functionName: 'settle',
      args: [BigInt(id)],
    });
  };

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">Auction #{id}</h1>
          <p className="text-sm text-neutral-500">
            Token #{auction.tokenId} · seller {shortAddress(auction.seller)}
          </p>
        </header>

        <div className="card">
          <h2 className="mb-3 text-sm font-medium">Bid history</h2>
          {(auction.bids?.length ?? 0) === 0 ? (
            <p className="text-sm text-neutral-600">No bids yet.</p>
          ) : (
            <ul className="divide-y divide-neutral-800 text-sm">
              {auction.bids!.map((bid) => (
                <li key={bid.id} className="flex items-center justify-between py-2.5">
                  <div>
                    <p>{shortAddress(bid.bidder)}</p>
                    <p className="text-xs text-neutral-600">{formatRelativeTime(bid.blockTime)}</p>
                  </div>
                  <span className="tabular-nums">{formatPrice(bid.amount)} ETH</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="space-y-4">
        <div className="card space-y-4">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-neutral-500">
              {auction.highestBid ? 'Current bid' : 'Reserve price'}
            </span>
            <span className="text-2xl font-semibold tabular-nums">
              {formatPrice(auction.highestBid ?? auction.reservePrice)} ETH
            </span>
          </div>

          {auction.highestBidder && (
            <p className="text-xs text-neutral-500">
              Leading: {shortAddress(auction.highestBidder)}
            </p>
          )}

          <div className="flex items-baseline justify-between border-t border-neutral-800 pt-3">
            <span className="text-sm text-neutral-500">
              {auction.status !== 'ACTIVE' ? 'Status' : ended ? 'Status' : 'Ends in'}
            </span>
            <span className="tabular-nums">
              {auction.status !== 'ACTIVE'
                ? auction.status.toLowerCase()
                : ended
                  ? 'Awaiting settlement'
                  : countdown}
            </span>
          </div>
        </div>

        {auction.status === 'ACTIVE' && !ended && (
          <div className="card space-y-3">
            <div>
              <label className="label" htmlFor="bid">
                Your bid (ETH)
              </label>
              <input
                id="bid"
                className="input tabular-nums"
                placeholder={formatPrice(minimumBid)}
                inputMode="decimal"
                value={bidInput}
                onChange={(event) => setBidInput(event.target.value)}
              />
              <p className="mt-1.5 text-xs text-neutral-500">
                Minimum {formatPrice(minimumBid)} ETH. A bid in the final minutes extends the
                auction, so late bidding gains nothing.
              </p>
            </div>

            <button
              type="button"
              className="btn-primary w-full"
              onClick={handleBid}
              disabled={
                !address || isSeller || bidWei === null || bidTooLow || isPending || confirming
              }
            >
              {!address
                ? 'Connect wallet'
                : isSeller
                  ? 'You are the seller'
                  : bidTooLow
                    ? 'Bid too low'
                    : isPending
                      ? 'Confirm in wallet…'
                      : confirming
                        ? 'Bidding…'
                        : 'Place bid'}
            </button>
          </div>
        )}

        {auction.status === 'ACTIVE' && ended && (
          <div className="card space-y-3">
            <p className="text-sm text-neutral-400">
              This auction has ended. Anyone can settle it: the asset goes to the winner and the
              proceeds to the seller regardless of who pays the gas.
            </p>
            <button
              type="button"
              className="btn-primary w-full"
              onClick={handleSettle}
              disabled={!address || isPending || confirming}
            >
              {isPending ? 'Confirm in wallet…' : confirming ? 'Settling…' : 'Settle auction'}
            </button>
          </div>
        )}

        {error && <p className="text-sm text-red-400">{error.message.split('\n')[0]}</p>}
      </div>
    </div>
  );
}
