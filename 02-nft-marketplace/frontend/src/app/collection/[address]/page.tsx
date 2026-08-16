'use client';

import {useInfiniteQuery, useQuery} from '@tanstack/react-query';
import {use, useMemo, useState} from 'react';
import {TokenCard} from '@/components/TokenCard';
import {api} from '@/lib/api';
import {cn} from '@/lib/cn';
import {formatCompact, formatPrice, formatRelativeTime, shortAddress} from '@/lib/format';

export default function CollectionPage({params}: {params: Promise<{address: string}>}) {
  const {address} = use(params);
  const [selectedTraits, setSelectedTraits] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<'items' | 'activity'>('items');

  const {data: collectionData} = useQuery({
    queryKey: ['collection', address],
    queryFn: () => api.collection(address),
  });

  // `traits` is part of the key, so changing a filter starts a fresh paginated query rather than
  // appending filtered results onto unfiltered ones.
  const traits = useMemo(() => [...selectedTraits].sort(), [selectedTraits]);

  const {data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading} = useInfiniteQuery({
    queryKey: ['tokens', address, traits],
    queryFn: ({pageParam}) => api.tokens(address, {traits, cursor: pageParam, limit: 24}),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const {data: activityData} = useQuery({
    queryKey: ['activity', address],
    queryFn: () => api.activity(address, {limit: 50}),
    enabled: tab === 'activity',
  });

  const tokens = data?.pages.flatMap((page) => page.tokens) ?? [];

  // Facets are derived from what has loaded so far. A dedicated aggregation endpoint would be
  // better for a large collection, but this keeps the demo to one query and stays correct.
  const facets = useMemo(() => {
    const map = new Map<string, Map<string, number>>();

    for (const token of tokens) {
      for (const attribute of token.attributes ?? []) {
        const values = map.get(attribute.trait_type) ?? new Map<string, number>();
        values.set(attribute.value, (values.get(attribute.value) ?? 0) + 1);
        map.set(attribute.trait_type, values);
      }
    }

    return [...map.entries()].map(([traitType, values]) => ({
      traitType,
      values: [...values.entries()].sort((a, b) => b[1] - a[1]),
    }));
  }, [tokens]);

  const toggleTrait = (traitType: string, value: string) => {
    const key = `${traitType}:${value}`;
    setSelectedTraits((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const collection = collectionData?.collection;

  return (
    <div className="space-y-8">
      <header className="space-y-4">
        <h1 className="text-3xl font-semibold tracking-tight">
          {collection?.name ?? shortAddress(address)}
        </h1>

        <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <div>
            <dt className="text-neutral-500">Floor</dt>
            <dd className="font-medium tabular-nums">
              {collection?.floorPrice ? `${formatPrice(collection.floorPrice)} ETH` : '-'}
            </dd>
          </div>
          <div>
            <dt className="text-neutral-500">24h volume</dt>
            <dd className="font-medium tabular-nums">
              {collection ? `${formatCompact(collection.volume24h)} ETH` : '-'}
            </dd>
          </div>
          <div>
            <dt className="text-neutral-500">Owners</dt>
            <dd className="font-medium tabular-nums">{collection?.ownerCount ?? '-'}</dd>
          </div>
        </dl>
      </header>

      <div className="flex gap-1 border-b border-neutral-800">
        {(['items', 'activity'] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={cn(
              '-mb-px border-b-2 px-4 py-2.5 text-sm font-medium capitalize transition-colors',
              tab === value
                ? 'border-indigo-500 text-white'
                : 'border-transparent text-neutral-500 hover:text-neutral-300',
            )}
          >
            {value}
          </button>
        ))}
      </div>

      {tab === 'items' ? (
        <div className="grid gap-8 lg:grid-cols-[240px_minmax(0,1fr)]">
          <aside className="space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium">Traits</h2>
              {selectedTraits.size > 0 && (
                <button
                  type="button"
                  onClick={() => setSelectedTraits(new Set())}
                  className="text-xs text-indigo-400 hover:text-indigo-300"
                >
                  Clear
                </button>
              )}
            </div>

            {facets.length === 0 ? (
              <p className="text-sm text-neutral-600">No traits indexed yet.</p>
            ) : (
              facets.map((facet) => (
                <div key={facet.traitType} className="space-y-2">
                  <h3 className="text-xs uppercase tracking-wide text-neutral-500">
                    {facet.traitType}
                  </h3>
                  <div className="space-y-1">
                    {facet.values.map(([value, count]) => {
                      const key = `${facet.traitType}:${value}`;
                      const active = selectedTraits.has(key);

                      return (
                        <button
                          key={value}
                          type="button"
                          onClick={() => toggleTrait(facet.traitType, value)}
                          className={cn(
                            'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                            active
                              ? 'bg-indigo-500/15 text-indigo-300'
                              : 'text-neutral-400 hover:bg-neutral-900',
                          )}
                        >
                          <span className="truncate">{value}</span>
                          <span className="ml-2 tabular-nums text-xs text-neutral-600">
                            {count}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </aside>

          <div className="space-y-6">
            {isLoading ? (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
                {Array.from({length: 8}, (_unused, index) => (
                  <div
                    key={index}
                    className="aspect-square animate-pulse rounded-xl bg-neutral-900"
                  />
                ))}
              </div>
            ) : tokens.length === 0 ? (
              <p className="py-16 text-center text-neutral-600">No tokens match these filters.</p>
            ) : (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
                {tokens.map((token) => (
                  <TokenCard key={token.id} token={token} />
                ))}
              </div>
            )}

            {hasNextPage && (
              <button
                type="button"
                className="btn-secondary mx-auto block"
                onClick={() => void fetchNextPage()}
                disabled={isFetchingNextPage}
              >
                {isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-neutral-800">
          <table className="w-full text-sm">
            <thead className="bg-neutral-900/50 text-left text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-3">Token</th>
                <th className="px-4 py-3">Price</th>
                <th className="px-4 py-3">From</th>
                <th className="px-4 py-3">To</th>
                <th className="px-4 py-3">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {(activityData?.activity ?? []).map((fill) => (
                <tr key={fill.id} className="hover:bg-neutral-900/40">
                  <td className="px-4 py-3">#{fill.tokenId}</td>
                  <td className="px-4 py-3 tabular-nums">{formatPrice(fill.price)} ETH</td>
                  <td className="px-4 py-3 text-neutral-400">{shortAddress(fill.maker)}</td>
                  <td className="px-4 py-3 text-neutral-400">{shortAddress(fill.taker)}</td>
                  <td className="px-4 py-3 text-neutral-500">
                    {formatRelativeTime(fill.blockTime)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {(activityData?.activity.length ?? 0) === 0 && (
            <p className="py-16 text-center text-neutral-600">No sales yet.</p>
          )}
        </div>
      )}
    </div>
  );
}
