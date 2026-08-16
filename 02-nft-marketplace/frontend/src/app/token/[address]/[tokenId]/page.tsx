'use client';

import {useQuery} from '@tanstack/react-query';
import {use} from 'react';
import {TradePanel} from '@/components/TradePanel';
import {api} from '@/lib/api';
import {formatPrice, formatRelativeTime, shortAddress} from '@/lib/format';

export default function TokenPage({
  params,
}: {
  params: Promise<{address: string; tokenId: string}>;
}) {
  const {address, tokenId} = use(params);

  const {data, isLoading} = useQuery({
    queryKey: ['token', address, tokenId],
    queryFn: () => api.token(address, tokenId),
  });

  if (isLoading) {
    return (
      <div className="grid gap-8 lg:grid-cols-2">
        <div className="aspect-square animate-pulse rounded-xl bg-neutral-900" />
        <div className="space-y-4">
          <div className="h-8 w-1/2 animate-pulse rounded bg-neutral-900" />
          <div className="h-32 animate-pulse rounded-xl bg-neutral-900" />
        </div>
      </div>
    );
  }

  if (!data) {
    return <p className="py-16 text-center text-neutral-600">Token not found.</p>;
  }

  const {token} = data;
  const image = token.metadata?.imageUrl;
  const owner = token.owners[0]?.owner ?? null;

  return (
    <div className="grid gap-10 lg:grid-cols-2">
      <div className="space-y-6">
        <div className="aspect-square overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900">
          {image ? (
            <img
              src={image}
              alt={token.metadata?.name ?? `#${tokenId}`}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-neutral-600">
              Not revealed yet
            </div>
          )}
        </div>

        {(token.metadata?.attributes?.length ?? 0) > 0 && (
          <div className="card">
            <h2 className="mb-3 text-sm font-medium">Traits</h2>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {token.metadata!.attributes!.map((attribute) => (
                <div
                  key={`${attribute.trait_type}-${attribute.value}`}
                  className="rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2"
                >
                  <p className="truncate text-xs uppercase tracking-wide text-neutral-500">
                    {attribute.trait_type}
                  </p>
                  <p className="truncate text-sm">{attribute.value}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">
            {token.metadata?.name ?? `#${tokenId}`}
          </h1>
          <p className="text-sm text-neutral-500">
            Owned by <span className="text-neutral-300">{owner ? shortAddress(owner) : '-'}</span>
          </p>
        </header>

        <TradePanel
          collection={address}
          tokenId={tokenId}
          owner={owner}
          listings={token.listings}
          offers={token.offers}
        />

        {token.offers.length > 0 && (
          <div className="card">
            <h2 className="mb-3 text-sm font-medium">Offers</h2>
            <ul className="divide-y divide-neutral-800 text-sm">
              {token.offers.map((offer) => (
                <li key={offer.hash} className="flex justify-between py-2.5">
                  <span className="text-neutral-400">{shortAddress(offer.maker)}</span>
                  <span className="tabular-nums">{formatPrice(offer.price)} WETH</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="card">
          <h2 className="mb-3 text-sm font-medium">History</h2>
          {token.history.length === 0 ? (
            <p className="text-sm text-neutral-600">No sales yet.</p>
          ) : (
            <ul className="divide-y divide-neutral-800 text-sm">
              {token.history.map((fill) => (
                <li key={fill.id} className="flex items-center justify-between py-2.5">
                  <div>
                    <p>
                      {shortAddress(fill.maker)} → {shortAddress(fill.taker)}
                    </p>
                    <p className="text-xs text-neutral-600">
                      {formatRelativeTime(fill.blockTime)}
                    </p>
                  </div>
                  <span className="tabular-nums">{formatPrice(fill.price)} ETH</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
