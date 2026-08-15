'use client';

import {useQuery, useQueryClient} from '@tanstack/react-query';
import Link from 'next/link';
import {useEffect} from 'react';
import {useAccount, useWaitForTransactionReceipt, useWriteContract} from 'wagmi';
import {api, type ProposalState} from '@/lib/api';
import {cn} from '@/lib/cn';
import {contracts, tokenAbi} from '@/lib/contracts';
import {formatCountdown, formatPrice, shortAddress} from '@/lib/format';

const STATE_STYLES: Record<ProposalState, string> = {
  PENDING: 'bg-neutral-800 text-neutral-300',
  ACTIVE: 'bg-emerald-500/15 text-emerald-300',
  CANCELED: 'bg-neutral-800 text-neutral-500',
  DEFEATED: 'bg-red-500/15 text-red-300',
  SUCCEEDED: 'bg-indigo-500/15 text-indigo-300',
  QUEUED: 'bg-amber-500/15 text-amber-300',
  EXPIRED: 'bg-neutral-800 text-neutral-500',
  EXECUTED: 'bg-emerald-500/15 text-emerald-300',
};

export default function GovernancePage() {
  const {address} = useAccount();
  const queryClient = useQueryClient();

  const {data: token} = useQuery({queryKey: ['token'], queryFn: api.token});

  const {data: proposalsData, isLoading} = useQuery({
    queryKey: ['proposals'],
    queryFn: () => api.proposals(),
    refetchInterval: 20_000,
  });

  const {data: power} = useQuery({
    queryKey: ['votingPower', address],
    queryFn: () => api.votingPower(address!),
    enabled: Boolean(address),
  });

  const {writeContract, data: hash, isPending} = useWriteContract();
  const {isLoading: confirming, isSuccess} = useWaitForTransactionReceipt({hash});

  useEffect(() => {
    if (isSuccess) void queryClient.invalidateQueries({queryKey: ['votingPower', address]});
  }, [isSuccess, queryClient, address]);

  const symbol = token?.symbol ?? 'PRJ';
  const proposals = proposalsData?.proposals ?? [];

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Governance</h1>
        <p className="max-w-2xl text-neutral-400">
          Proposals execute through a timelock, so every approved action sits in a public queue
          before it can run. Voting power is snapshotted when a vote opens, which is what makes
          borrowing tokens to vote pointless.
        </p>
      </header>

      {/* Delegation banner. Holding tokens confers no voting power until delegated, and this is by
          far the most common reason a holder finds they cannot vote. */}
      {address && power && !power.hasDelegated && BigInt(power.balance) > 0n && (
        <div className="card flex flex-wrap items-center justify-between gap-4 border-amber-900 bg-amber-950/20">
          <div>
            <p className="font-medium text-amber-200">
              Your {formatPrice(power.balance)} {symbol} carries no voting power yet
            </p>
            <p className="text-sm text-amber-300/70">
              Tokens only vote once delegated, including to yourself. This is a one-time action.
            </p>
          </div>
          <button
            type="button"
            className="btn-primary"
            onClick={() =>
              writeContract({
                address: contracts.token,
                abi: tokenAbi,
                functionName: 'delegate',
                args: [address],
              })
            }
            disabled={isPending || confirming}
          >
            {isPending || confirming ? 'Delegating…' : 'Delegate to self'}
          </button>
        </div>
      )}

      {address && power && (
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="card">
            <p className="text-xs uppercase tracking-wide text-neutral-500">Your voting power</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {formatPrice(power.votes)} {symbol}
            </p>
          </div>
          <div className="card">
            <p className="text-xs uppercase tracking-wide text-neutral-500">Proposal threshold</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {formatPrice(power.proposalThreshold)} {symbol}
            </p>
          </div>
          <div className="card">
            <p className="text-xs uppercase tracking-wide text-neutral-500">Can propose</p>
            <p
              className={cn(
                'mt-1 text-2xl font-semibold',
                power.canPropose ? 'text-emerald-400' : 'text-neutral-500',
              )}
            >
              {power.canPropose ? 'Yes' : 'No'}
            </p>
          </div>
        </div>
      )}

      <section className="space-y-4">
        <h2 className="text-lg font-medium">Proposals</h2>

        {isLoading ? (
          <div className="space-y-3">
            {Array.from({length: 3}, (_unused, index) => (
              <div key={index} className="h-28 animate-pulse rounded-xl bg-neutral-900" />
            ))}
          </div>
        ) : proposals.length === 0 ? (
          <p className="py-16 text-center text-neutral-600">No proposals yet.</p>
        ) : (
          <div className="space-y-3">
            {proposals.map((proposal) => {
              const forVotes = BigInt(proposal.forVotes);
              const againstVotes = BigInt(proposal.againstVotes);
              const cast = forVotes + againstVotes + BigInt(proposal.abstainVotes);
              const forPercent = cast === 0n ? 0 : Number((forVotes * 10_000n) / cast) / 100;

              // First line of the description is the title, by convention.
              const title = proposal.description.split('\n')[0] ?? `Proposal ${proposal.id}`;

              return (
                <Link
                  key={proposal.id}
                  href={`/governance/${proposal.id}`}
                  className="card block space-y-3 transition-colors hover:border-neutral-700"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate font-medium">{title}</h3>
                      <p className="text-sm text-neutral-500">
                        by {shortAddress(proposal.proposer)}
                      </p>
                    </div>

                    <span
                      className={cn(
                        'shrink-0 rounded-full px-2.5 py-1 text-xs capitalize',
                        STATE_STYLES[proposal.state],
                      )}
                    >
                      {proposal.state.toLowerCase()}
                    </span>
                  </div>

                  {cast > 0n && (
                    <div>
                      <div className="flex h-1.5 overflow-hidden rounded-full bg-neutral-800">
                        <div className="bg-emerald-500" style={{width: `${forPercent}%`}} />
                        <div className="bg-red-500" style={{width: `${100 - forPercent}%`}} />
                      </div>
                      <div className="mt-1.5 flex justify-between text-xs text-neutral-500">
                        <span>{formatPrice(proposal.forVotes)} for</span>
                        <span>{formatPrice(proposal.againstVotes)} against</span>
                      </div>
                    </div>
                  )}

                  {proposal.state === 'ACTIVE' && (
                    <p className="text-xs text-neutral-500">
                      Voting ends in {formatCountdown(proposal.voteEnd) ?? 'moments'}
                    </p>
                  )}
                  {proposal.state === 'QUEUED' && proposal.etaAt && (
                    <p className="text-xs text-amber-400">
                      Executable in {formatCountdown(proposal.etaAt) ?? 'now'}
                    </p>
                  )}
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
