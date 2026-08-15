'use client';

import {useQuery, useQueryClient} from '@tanstack/react-query';
import {useEffect} from 'react';
import {useAccount, useWaitForTransactionReceipt, useWriteContract} from 'wagmi';
import {api} from '@/lib/api';
import {contracts, distributorAbi} from '@/lib/contracts';
import {formatCountdown, formatPrice} from '@/lib/format';

export default function ClaimPage() {
  const {address} = useAccount();
  const queryClient = useQueryClient();

  const {data: token} = useQuery({queryKey: ['token'], queryFn: api.token});

  const {data: stats} = useQuery({
    queryKey: ['airdropStats'],
    queryFn: api.airdropStats,
    refetchInterval: 30_000,
  });

  const {data: claim, isLoading} = useQuery({
    queryKey: ['claim', address],
    queryFn: () => api.claim(address!),
    enabled: Boolean(address),
  });

  const {writeContract, data: hash, isPending, error} = useWriteContract();
  const {isLoading: confirming, isSuccess} = useWaitForTransactionReceipt({hash});

  useEffect(() => {
    if (isSuccess) {
      void queryClient.invalidateQueries({queryKey: ['claim', address]});
      void queryClient.invalidateQueries({queryKey: ['airdropStats']});
    }
  }, [isSuccess, queryClient, address]);

  const symbol = token?.symbol ?? 'PRJ';
  const claimedPercent =
    stats && stats.entryCount > 0 ? (stats.claimedCount / stats.entryCount) * 100 : 0;

  const handleClaim = () => {
    if (!claim || !address) return;

    writeContract({
      address: contracts.distributor,
      abi: distributorAbi,
      functionName: 'claim',
      // The account comes from the leaf, not from the connected wallet. They are the same here, but
      // the contract pays the leaf address regardless of who submits, so a relayer could do this.
      args: [BigInt(claim.index), claim.address as `0x${string}`, BigInt(claim.amount), claim.proof],
    });
  };

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Airdrop</h1>
        <p className="max-w-2xl text-neutral-400">
          Claims are verified against a Merkle root published on-chain. Claim state is packed into a
          bitmap, so each claim after the first in a 256-address block costs a fraction of a normal
          storage write.
        </p>
      </header>

      {stats && (
        <div className="card space-y-3">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-neutral-500">Claimed</span>
            <span className="tabular-nums">
              {stats.claimedCount.toLocaleString()} / {stats.entryCount.toLocaleString()} wallets
            </span>
          </div>

          <div className="h-2 overflow-hidden rounded-full bg-neutral-800">
            <div
              className="h-full rounded-full bg-indigo-500 transition-[width] duration-500"
              style={{width: `${claimedPercent}%`}}
            />
          </div>

          <div className="flex justify-between text-sm text-neutral-500">
            <span>
              {formatPrice(stats.totalClaimed)} of {formatPrice(stats.totalAllocated)} {symbol}
            </span>
          </div>

          {/* A root mismatch means the database and the deployed contract disagree about who is
              eligible, so every proof served would fail on-chain. Worth shouting about. */}
          {stats.rootMatchesChain === false && (
            <p className="rounded-lg border border-red-900 bg-red-950/30 px-3 py-2 text-sm text-red-300">
              The stored allocation list does not match the root deployed on-chain. Proofs served
              from this API will not verify.
            </p>
          )}
        </div>
      )}

      <div className="card space-y-4">
        {!address ? (
          <p className="py-8 text-center text-neutral-500">Connect a wallet to check eligibility.</p>
        ) : isLoading ? (
          <p className="py-8 text-center text-neutral-500">Checking eligibility…</p>
        ) : !claim ? (
          <div className="py-8 text-center">
            <p className="text-neutral-300">This wallet has no allocation.</p>
            <p className="mt-1 text-sm text-neutral-500">
              Allocations were snapshotted before the airdrop opened.
            </p>
          </div>
        ) : (
          <>
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-neutral-500">Your allocation</span>
              <span className="text-3xl font-semibold tabular-nums">
                {formatPrice(claim.amount)} {symbol}
              </span>
            </div>

            <dl className="grid grid-cols-2 gap-4 border-t border-neutral-800 pt-4 text-sm">
              <div>
                <dt className="text-neutral-500">Index</dt>
                <dd className="tabular-nums">#{claim.index}</dd>
              </div>
              <div>
                <dt className="text-neutral-500">Deadline</dt>
                <dd className="tabular-nums">
                  {formatCountdown(claim.deadline * 1000) ?? 'Passed'}
                </dd>
              </div>
            </dl>

            {claim.claimed ? (
              <p className="rounded-lg border border-emerald-900 bg-emerald-950/30 px-4 py-3 text-sm text-emerald-300">
                Already claimed{claim.claimedAt ? ` on ${new Date(claim.claimedAt).toLocaleDateString()}` : ''}.
              </p>
            ) : claim.expired ? (
              <p className="rounded-lg border border-amber-900 bg-amber-950/30 px-4 py-3 text-sm text-amber-300">
                The claim window has closed. Unclaimed tokens have been returned to the treasury.
              </p>
            ) : (
              <button
                type="button"
                className="btn-primary w-full"
                onClick={handleClaim}
                disabled={isPending || confirming}
              >
                {isPending ? 'Confirm in wallet…' : confirming ? 'Claiming…' : `Claim ${formatPrice(claim.amount)} ${symbol}`}
              </button>
            )}

            {error && <p className="text-sm text-red-400">{error.message.split('\n')[0]}</p>}
          </>
        )}
      </div>
    </div>
  );
}
