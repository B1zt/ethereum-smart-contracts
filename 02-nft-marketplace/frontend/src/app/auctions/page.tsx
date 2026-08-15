'use client';

import {useQuery} from '@tanstack/react-query';
import Link from 'next/link';
import {useEffect, useState} from 'react';
import {api} from '@/lib/api';
import {cn} from '@/lib/cn';
import {formatCountdown, formatPrice, shortAddress} from '@/lib/format';

export default function AuctionsPage() {
  const [filter, setFilter] = useState<'ACTIVE' | 'SETTLED'>('ACTIVE');
  const [, forceTick] = useState(0);

  // Countdowns are computed from `endTime` on every render, so a one-second tick keeps them moving
  // without any per-card timers.
  useEffect(() => {
    const timer = setInterval(() => forceTick((value) => value + 1), 1_000);
    return () => clearInterval(timer);
  }, []);

  const {data, isLoading} = useQuery({
    queryKey: ['auctions', filter],
    queryFn: () => api.auctions({status: filter, limit: 50}),
    refetchInterval: 10_000,
  });

  const auctions = data?.auctions ?? [];

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">Auctions</h1>

        <div className="flex gap-2">
          {(['ACTIVE', 'SETTLED'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              className={cn(
                'rounded-lg border px-3 py-1.5 text-sm capitalize transition-colors',
                filter === value
                  ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300'
                  : 'border-neutral-800 text-neutral-400 hover:border-neutral-700',
              )}
            >
              {value.toLowerCase()}
            </button>
          ))}
        </div>
      </header>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({length: 6}, (_unused, index) => (
            <div key={index} className="h-40 animate-pulse rounded-xl bg-neutral-900" />
          ))}
        </div>
      ) : auctions.length === 0 ? (
        <p className="py-16 text-center text-neutral-600">No {filter.toLowerCase()} auctions.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {auctions.map((auction) => {
            const countdown = formatCountdown(auction.endTime);
            const settleable = auction.status === 'ACTIVE' && countdown === null;

            return (
              <Link
                key={auction.id}
                href={`/auctions/${auction.id}`}
                className="card space-y-4 transition-colors hover:border-neutral-700"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <p className="font-medium">#{auction.tokenId}</p>
                    <p className="text-xs text-neutral-500">{shortAddress(auction.seller)}</p>
                  </div>

                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-xs',
                      settleable
                        ? 'bg-amber-500/15 text-amber-300'
                        : auction.status === 'ACTIVE'
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : 'bg-neutral-800 text-neutral-400',
                    )}
                  >
                    {settleable ? 'Ready to settle' : auction.status.toLowerCase()}
                  </span>
                </div>

                <div className="flex items-end justify-between">
                  <div>
                    <p className="text-xs text-neutral-500">
                      {auction.highestBid ? 'Current bid' : 'Reserve'}
                    </p>
                    <p className="text-lg font-semibold tabular-nums">
                      {formatPrice(auction.highestBid ?? auction.reservePrice)} ETH
                    </p>
                  </div>

                  {auction.status === 'ACTIVE' && (
                    <div className="text-right">
                      <p className="text-xs text-neutral-500">Ends in</p>
                      <p className="tabular-nums">{countdown ?? 'ended'}</p>
                    </div>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
