'use client';

import {useQuery} from '@tanstack/react-query';
import Link from 'next/link';
import {useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract} from 'wagmi';
import {api} from '@/lib/api';
import {contracts, marketplaceAbi} from '@/lib/contracts';
import {formatPrice, shortAddress} from '@/lib/format';

export default function PortfolioPage() {
  const {address} = useAccount();

  const {data, isLoading} = useQuery({
    queryKey: ['portfolio', address],
    queryFn: () => api.portfolio(address!),
    enabled: Boolean(address),
  });

  // Proceeds that could not be pushed at settlement time, usually because the recipient is a
  // contract that rejects ETH. They sit here until claimed.
  const {data: escrowed} = useReadContract({
    address: contracts.marketplace,
    abi: marketplaceAbi,
    functionName: 'escrowedBalance',
    args: address ? [address] : undefined,
    query: {enabled: Boolean(address)},
  });

  const {writeContract, data: hash, isPending} = useWriteContract();
  const {isLoading: confirming} = useWaitForTransactionReceipt({hash});

  if (!address) {
    return (
      <p className="py-24 text-center text-neutral-500">Connect a wallet to see your portfolio.</p>
    );
  }

  if (isLoading || !data) {
    return <div className="h-64 animate-pulse rounded-xl bg-neutral-900" />;
  }

  return (
    <div className="space-y-10">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">Portfolio</h1>
        <p className="text-sm text-neutral-500">{shortAddress(address)}</p>
      </header>

      {(escrowed ?? 0n) > 0n && (
        <div className="card flex flex-wrap items-center justify-between gap-4 border-amber-900 bg-amber-950/20">
          <div>
            <p className="font-medium text-amber-200">
              {formatPrice(escrowed!)} ETH waiting to be claimed
            </p>
            <p className="text-sm text-amber-300/70">
              A payout to your address could not be sent directly, so it was held for you instead.
            </p>
          </div>
          <button
            type="button"
            className="btn-primary"
            onClick={() =>
              writeContract({
                address: contracts.marketplace,
                abi: marketplaceAbi,
                functionName: 'withdrawEscrow',
              })
            }
            disabled={isPending || confirming}
          >
            {isPending || confirming ? 'Claiming…' : 'Claim'}
          </button>
        </div>
      )}

      <section className="space-y-4">
        <h2 className="text-lg font-medium">Holdings ({data.holdings.length})</h2>

        {data.holdings.length === 0 ? (
          <p className="text-neutral-600">Nothing here yet.</p>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5">
            {data.holdings.map((holding) => (
              <Link
                key={`${holding.collection}-${holding.tokenId}`}
                href={`/token/${holding.collection}/${holding.tokenId}`}
                className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/50 transition-colors hover:border-neutral-700"
              >
                <div className="aspect-square bg-neutral-900">
                  {holding.metadata?.thumbnailUrl ?? holding.metadata?.imageUrl ? (
                    <img
                      src={holding.metadata.thumbnailUrl ?? holding.metadata.imageUrl!}
                      alt={holding.metadata.name ?? `#${holding.tokenId}`}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs text-neutral-600">
                      #{holding.tokenId}
                    </div>
                  )}
                </div>
                <p className="truncate p-3 text-sm">
                  {holding.metadata?.name ?? `#${holding.tokenId}`}
                </p>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="card">
          <h2 className="mb-3 font-medium">Your listings ({data.listings.length})</h2>
          {data.listings.length === 0 ? (
            <p className="text-sm text-neutral-600">No active listings.</p>
          ) : (
            <ul className="divide-y divide-neutral-800 text-sm">
              {data.listings.map((order) => (
                <li key={order.hash} className="flex justify-between py-2.5">
                  <Link
                    href={`/token/${order.collection}/${order.tokenId}`}
                    className="hover:text-white"
                  >
                    #{order.tokenId}
                  </Link>
                  <span className="tabular-nums">{formatPrice(order.price)} ETH</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card">
          <h2 className="mb-3 font-medium">Your offers ({data.offers.length})</h2>
          {data.offers.length === 0 ? (
            <p className="text-sm text-neutral-600">No active offers.</p>
          ) : (
            <ul className="divide-y divide-neutral-800 text-sm">
              {data.offers.map((order) => (
                <li key={order.hash} className="flex justify-between py-2.5">
                  <Link
                    href={`/token/${order.collection}/${order.tokenId}`}
                    className="hover:text-white"
                  >
                    #{order.tokenId}
                  </Link>
                  <span className="tabular-nums">{formatPrice(order.price)} WETH</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="card">
        <h2 className="mb-2 font-medium">Cancel everything</h2>
        <p className="mb-4 text-sm text-neutral-500">
          Bumping your nonce invalidates every order you have ever signed, in one transaction. Use
          it if a key is compromised or you simply want a clean slate.
        </p>
        <button
          type="button"
          className="btn-secondary"
          onClick={() =>
            writeContract({
              address: contracts.marketplace,
              abi: marketplaceAbi,
              functionName: 'incrementNonce',
            })
          }
          disabled={isPending || confirming}
        >
          {isPending || confirming ? 'Cancelling…' : 'Cancel all orders'}
        </button>
      </section>
    </div>
  );
}
