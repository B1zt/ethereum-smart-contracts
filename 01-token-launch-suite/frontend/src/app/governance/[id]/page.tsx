'use client';

import {useQuery, useQueryClient} from '@tanstack/react-query';
import {use, useEffect, useState} from 'react';
import {keccak256, toBytes} from 'viem';
import {useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract} from 'wagmi';
import {api} from '@/lib/api';
import {cn} from '@/lib/cn';
import {contracts, governorAbi, VOTE_SUPPORT} from '@/lib/contracts';
import {formatCountdown, formatPrice, formatRelativeTime, shortAddress} from '@/lib/format';

export default function ProposalPage({params}: {params: Promise<{id: string}>}) {
  const {id} = use(params);
  const {address} = useAccount();
  const queryClient = useQueryClient();

  const [reason, setReason] = useState('');

  const {data, isLoading} = useQuery({
    queryKey: ['proposal', id],
    queryFn: () => api.proposal(id),
    refetchInterval: 15_000,
  });

  const {data: power} = useQuery({
    queryKey: ['votingPower', address],
    queryFn: () => api.votingPower(address!),
    enabled: Boolean(address),
  });

  const {data: hasVoted, refetch: refetchHasVoted} = useReadContract({
    address: contracts.governor,
    abi: governorAbi,
    functionName: 'hasVoted',
    args: address ? [BigInt(id), address] : undefined,
    query: {enabled: Boolean(address)},
  });

  const {writeContract, data: hash, isPending, error} = useWriteContract();
  const {isLoading: confirming, isSuccess} = useWaitForTransactionReceipt({hash});

  useEffect(() => {
    if (!isSuccess) return;
    setReason('');
    void refetchHasVoted();
    void queryClient.invalidateQueries({queryKey: ['proposal', id]});
  }, [isSuccess, queryClient, id, refetchHasVoted]);

  if (isLoading || !data) {
    return <div className="h-64 animate-pulse rounded-xl bg-neutral-900" />;
  }

  const {proposal} = data;
  const busy = isPending || confirming;

  const forVotes = BigInt(proposal.forVotes);
  const againstVotes = BigInt(proposal.againstVotes);
  const abstainVotes = BigInt(proposal.abstainVotes);
  const cast = forVotes + againstVotes + abstainVotes;

  const percent = (value: bigint) => (cast === 0n ? 0 : Number((value * 10_000n) / cast) / 100);

  const [title, ...bodyLines] = proposal.description.split('\n');
  const body = bodyLines.join('\n').trim();

  const votingPower = BigInt(power?.votes ?? '0');
  const canVote = proposal.state === 'ACTIVE' && votingPower > 0n && hasVoted !== true;

  const vote = (support: number) => {
    writeContract({
      address: contracts.governor,
      abi: governorAbi,
      functionName: reason.trim() ? 'castVoteWithReason' : 'castVote',
      args: reason.trim()
        ? [BigInt(id), support, reason.trim()]
        : ([BigInt(id), support] as never),
    });
  };

  /**
   * Queue and execute both re-derive the proposal id from its parameters, so the exact targets,
   * values, calldatas and description hash must be passed back. That is why the indexer stores
   * them: they are only ever emitted once, in ProposalCreated.
   */
  const descriptionHash = keccak256(toBytes(proposal.description));
  const proposalArgs = [
    proposal.targets as `0x${string}`[],
    proposal.values.map((value) => BigInt(value)),
    proposal.calldatas as `0x${string}`[],
    descriptionHash,
  ] as const;

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-6">
        <header className="space-y-2">
          <p className="text-sm text-neutral-500">Proposal #{id}</p>
          <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
          <p className="text-sm text-neutral-500">
            Proposed by {shortAddress(proposal.proposer)}
          </p>
        </header>

        {body && (
          <div className="card whitespace-pre-wrap text-sm leading-relaxed text-neutral-300">
            {body}
          </div>
        )}

        <div className="card space-y-3">
          <h2 className="text-sm font-medium">On-chain actions</h2>
          <ul className="space-y-2 text-sm">
            {proposal.targets.map((target, index) => (
              <li key={index} className="rounded-lg border border-neutral-800 bg-neutral-950 p-3">
                <p className="text-neutral-500">Target</p>
                <p className="font-mono text-xs">{target}</p>
                {proposal.values[index] !== '0' && (
                  <p className="mt-1 text-neutral-400">
                    Value: {formatPrice(proposal.values[index]!)} ETH
                  </p>
                )}
                <p className="mt-1 text-neutral-500">Calldata</p>
                <p className="break-all font-mono text-xs text-neutral-400">
                  {proposal.calldatas[index]}
                </p>
              </li>
            ))}
          </ul>
        </div>

        {(proposal.votes?.length ?? 0) > 0 && (
          <div className="card">
            <h2 className="mb-3 text-sm font-medium">Votes</h2>
            <ul className="divide-y divide-neutral-800 text-sm">
              {proposal.votes!.map((entry) => (
                <li key={entry.id} className="py-3">
                  <div className="flex items-center justify-between">
                    <span>{shortAddress(entry.voter)}</span>
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-xs capitalize',
                        entry.support === 'FOR'
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : entry.support === 'AGAINST'
                            ? 'bg-red-500/15 text-red-300'
                            : 'bg-neutral-800 text-neutral-400',
                      )}
                    >
                      {entry.support.toLowerCase()} · {formatPrice(entry.weight)}
                    </span>
                  </div>
                  {entry.reason && (
                    <p className="mt-1 text-neutral-500">{entry.reason}</p>
                  )}
                  <p className="mt-1 text-xs text-neutral-600">
                    {formatRelativeTime(entry.blockTime)}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="space-y-4">
        <div className="card space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-neutral-500">Status</span>
            <span className="capitalize">{proposal.state.toLowerCase()}</span>
          </div>

          {proposal.state === 'ACTIVE' && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-neutral-500">Voting ends</span>
              <span className="tabular-nums">{formatCountdown(proposal.voteEnd) ?? 'now'}</span>
            </div>
          )}

          <div className="space-y-3 border-t border-neutral-800 pt-4">
            {(
              [
                ['For', forVotes, 'bg-emerald-500'],
                ['Against', againstVotes, 'bg-red-500'],
                ['Abstain', abstainVotes, 'bg-neutral-500'],
              ] as const
            ).map(([label, value, colour]) => (
              <div key={label}>
                <div className="mb-1 flex justify-between text-sm">
                  <span className="text-neutral-400">{label}</span>
                  <span className="tabular-nums">{formatPrice(value)}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-neutral-800">
                  <div className={cn('h-full', colour)} style={{width: `${percent(value)}%`}} />
                </div>
              </div>
            ))}
          </div>

          {proposal.quorum && (
            <div className="border-t border-neutral-800 pt-3 text-sm">
              <div className="flex justify-between">
                <span className="text-neutral-500">Quorum</span>
                <span
                  className={cn(
                    'tabular-nums',
                    proposal.quorumReached ? 'text-emerald-400' : 'text-neutral-400',
                  )}
                >
                  {formatPrice(forVotes + abstainVotes)} / {formatPrice(proposal.quorum)}
                </span>
              </div>
            </div>
          )}
        </div>

        {proposal.state === 'ACTIVE' && (
          <div className="card space-y-3">
            <h2 className="font-medium">Cast your vote</h2>

            {!address ? (
              <p className="text-sm text-neutral-500">Connect a wallet to vote.</p>
            ) : hasVoted ? (
              <p className="text-sm text-emerald-400">You have already voted on this proposal.</p>
            ) : votingPower === 0n ? (
              <p className="text-sm text-amber-400">
                You have no voting power at this proposal&apos;s snapshot. Delegating now applies to
                future proposals only.
              </p>
            ) : (
              <>
                <p className="text-sm text-neutral-500">
                  Voting with {formatPrice(votingPower)} votes.
                </p>

                <textarea
                  className="input min-h-20 resize-y"
                  placeholder="Reason (optional, stored on-chain)"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />

                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    className="btn bg-emerald-600 text-white hover:bg-emerald-500"
                    onClick={() => vote(VOTE_SUPPORT.For)}
                    disabled={!canVote || busy}
                  >
                    For
                  </button>
                  <button
                    type="button"
                    className="btn bg-red-600 text-white hover:bg-red-500"
                    onClick={() => vote(VOTE_SUPPORT.Against)}
                    disabled={!canVote || busy}
                  >
                    Against
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => vote(VOTE_SUPPORT.Abstain)}
                    disabled={!canVote || busy}
                  >
                    Abstain
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {proposal.state === 'SUCCEEDED' && (
          <div className="card space-y-3">
            <p className="text-sm text-neutral-400">
              This proposal passed. Queueing it starts the timelock delay, after which anyone can
              execute it.
            </p>
            <button
              type="button"
              className="btn-primary w-full"
              onClick={() =>
                writeContract({
                  address: contracts.governor,
                  abi: governorAbi,
                  functionName: 'queue',
                  args: proposalArgs,
                })
              }
              disabled={!address || busy}
            >
              {busy ? 'Queueing…' : 'Queue proposal'}
            </button>
          </div>
        )}

        {proposal.state === 'QUEUED' && (
          <div className="card space-y-3">
            {proposal.etaAt && formatCountdown(proposal.etaAt) ? (
              <p className="text-sm text-amber-300">
                Executable in {formatCountdown(proposal.etaAt)}. The delay exists so holders who
                disagree have time to exit.
              </p>
            ) : (
              <p className="text-sm text-neutral-400">
                The timelock delay has elapsed. Anyone can execute this.
              </p>
            )}
            <button
              type="button"
              className="btn-primary w-full"
              onClick={() =>
                writeContract({
                  address: contracts.governor,
                  abi: governorAbi,
                  functionName: 'execute',
                  args: proposalArgs,
                })
              }
              disabled={
                !address || busy || Boolean(proposal.etaAt && formatCountdown(proposal.etaAt))
              }
            >
              {busy ? 'Executing…' : 'Execute'}
            </button>
          </div>
        )}

        {error && <p className="text-sm text-red-400">{error.message.split('\n')[0]}</p>}
      </div>
    </div>
  );
}
