'use client';

import {useQuery} from '@tanstack/react-query';
import Link from 'next/link';
import {MintPanel} from '@/components/MintPanel';
import {api} from '@/lib/api';
import {contracts} from '@/lib/contracts';
import {formatCompact, formatPrice} from '@/lib/format';

function Stat({label, value}: {label: string; value: string}) {
  return (
    <div className="card">
      <p className="text-xs uppercase tracking-wide text-neutral-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

export default function HomePage() {
  const {data} = useQuery({
    queryKey: ['collection', contracts.collection],
    queryFn: () => api.collection(contracts.collection),
    refetchInterval: 30_000,
  });

  const collection = data?.collection;

  return (
    <div className="space-y-10">
      <section className="space-y-3">
        <h1 className="text-4xl font-semibold tracking-tight">
          {collection?.name ?? 'B1zt Genesis'}
        </h1>
        <p className="max-w-2xl text-neutral-400">
          Multi-phase minting with Merkle allowlists and per-address allowances, a gasless EIP-712
          order book, and auctions that extend on late bids. Every piece is on-chain and the
          contracts are open source.
        </p>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Floor"
          value={collection?.floorPrice ? `${formatPrice(collection.floorPrice)} ETH` : '-'}
        />
        <Stat
          label="Volume"
          value={collection ? `${formatCompact(collection.volumeAllTime)} ETH` : '-'}
        />
        <Stat label="Owners" value={collection ? collection.ownerCount.toLocaleString() : '-'} />
        <Stat
          label="Supply"
          value={
            collection
              ? `${Number(collection.totalMinted).toLocaleString()} / ${Number(collection.maxSupply).toLocaleString()}`
              : '-'
          }
        />
      </section>

      <section className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="space-y-6">
          <div className="card space-y-4">
            <h2 className="text-lg font-semibold">How this works</h2>
            <dl className="space-y-4 text-sm text-neutral-400">
              <div>
                <dt className="font-medium text-neutral-200">Listing costs no gas</dt>
                <dd>
                  Sellers sign an EIP-712 order in their wallet. Nothing touches the chain until
                  someone buys, and cancelling every order you ever signed costs one transaction.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-neutral-200">Allowlists carry allowances</dt>
                <dd>
                  Each Merkle leaf commits to an address and how many that address may mint, so one
                  root can express per-wallet tiers rather than a flat cap.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-neutral-200">Auctions cannot be sniped</dt>
                <dd>
                  A bid in the closing minutes pushes the end time out, so the winner is whoever
                  values the item most rather than whoever pays the highest priority fee.
                </dd>
              </div>
            </dl>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link href={`/collection/${contracts.collection}`} className="btn-secondary">
              Explore the collection
            </Link>
            <Link href="/auctions" className="btn-secondary">
              Live auctions
            </Link>
          </div>
        </div>

        <MintPanel />
      </section>
    </div>
  );
}
