'use client';

import {useQuery} from '@tanstack/react-query';
import {useEffect, useMemo, useState} from 'react';
import {useAccount, useWaitForTransactionReceipt, useWriteContract} from 'wagmi';
import {api, type ApiPhase} from '@/lib/api';
import {cn} from '@/lib/cn';
import {collectionAbi, contracts} from '@/lib/contracts';
import {formatCountdown, formatPrice} from '@/lib/format';

type PhaseState = 'upcoming' | 'live' | 'ended';

function phaseState(phase: ApiPhase, now: number): PhaseState {
  if (now < phase.startTime * 1000) return 'upcoming';
  if (now >= phase.endTime * 1000) return 'ended';
  return 'live';
}

/**
 * Mint interface.
 *
 * The eligibility logic is the interesting part. For an allowlist phase, three things have to line
 * up before the mint button is safe to enable:
 *
 *   1. The wallet is in the tree, which the backend answers with a proof or a 404.
 *   2. The wallet has allowance left, which is its leaf allowance minus what it already minted.
 *   3. The phase is live.
 *
 * All three are checked here so the user sees why they cannot mint, rather than discovering it as a
 * reverted transaction that still cost them gas.
 */
export function MintPanel() {
  const {address} = useAccount();
  const [quantity, setQuantity] = useState(1);
  const [selectedPhase, setSelectedPhase] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // One shared ticker rather than a timer per countdown.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const {data: phasesData, isLoading: phasesLoading} = useQuery({
    queryKey: ['phases', contracts.collection],
    queryFn: () => api.phases(contracts.collection),
  });

  const {data: collectionData} = useQuery({
    queryKey: ['collection', contracts.collection],
    queryFn: () => api.collection(contracts.collection),
    refetchInterval: 15_000,
  });

  const phases = phasesData?.phases ?? [];

  // Default to whichever phase is live, falling back to the next one due to open.
  const activePhaseId = useMemo(() => {
    if (selectedPhase !== null) return selectedPhase;

    const live = phases.findIndex((phase) => phaseState(phase, now) === 'live');
    if (live >= 0) return live;

    const upcoming = phases.findIndex((phase) => phaseState(phase, now) === 'upcoming');
    return upcoming >= 0 ? upcoming : 0;
  }, [phases, selectedPhase, now]);

  const phase = phases[activePhaseId];

  const {data: proof, isLoading: proofLoading} = useQuery({
    queryKey: ['proof', contracts.collection, activePhaseId, address],
    queryFn: () => api.proof(contracts.collection, activePhaseId, address!),
    // Public phases need no proof, so the lookup is skipped entirely.
    enabled: Boolean(address) && Boolean(phase) && !phase!.isPublic,
  });

  const {data: mintedData} = useQuery({
    queryKey: ['walletMinted', contracts.collection, activePhaseId, address],
    queryFn: () => api.walletMinted(contracts.collection, activePhaseId, address!),
    enabled: Boolean(address) && Boolean(phase),
  });

  const {writeContract, data: txHash, isPending, error: writeError, reset} = useWriteContract();
  const {isLoading: isConfirming, isSuccess} = useWaitForTransactionReceipt({hash: txHash});

  if (phasesLoading) {
    return <div className="card animate-pulse text-neutral-500">Loading mint phases…</div>;
  }

  if (!phase) {
    return <div className="card text-neutral-400">No mint phases have been configured yet.</div>;
  }

  const state = phaseState(phase, now);
  const alreadyMinted = Number(mintedData?.minted ?? '0');

  // Allowlist phases take the per-wallet cap from the Merkle leaf; public phases use maxPerWallet.
  const walletCap = phase.isPublic ? phase.maxPerWallet : (proof?.allowance ?? 0);
  const remaining = Math.max(0, walletCap - alreadyMinted);

  const eligible = phase.isPublic || Boolean(proof);
  const canMint =
    Boolean(address) && state === 'live' && eligible && remaining > 0 && quantity <= remaining;

  const totalCost = BigInt(phase.price) * BigInt(quantity);

  const handleMint = () => {
    reset();
    writeContract({
      address: contracts.collection,
      abi: collectionAbi,
      functionName: 'mint',
      args: [
        BigInt(activePhaseId),
        BigInt(quantity),
        BigInt(proof?.allowance ?? 0),
        // A public phase must send an empty proof: the contract rejects a non-empty one outright
        // rather than ignoring it, which catches integration bugs early.
        phase.isPublic ? [] : (proof?.proof ?? []),
      ],
      value: totalCost,
    });
  };

  const minted = Number(collectionData?.collection.totalMinted ?? '0');
  const supply = Number(collectionData?.collection.maxSupply ?? '0');
  const progress = supply > 0 ? Math.min(100, (minted / supply) * 100) : 0;

  return (
    <div className="card space-y-6">
      {/* Supply progress */}
      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Mint</h2>
          <span className="text-sm tabular-nums text-neutral-400">
            {minted.toLocaleString()} / {supply.toLocaleString()}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-neutral-800">
          <div
            className="h-full rounded-full bg-indigo-500 transition-[width] duration-500"
            style={{width: `${progress}%`}}
          />
        </div>
      </div>

      {/* Phase selector */}
      {phases.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {phases.map((candidate, index) => {
            const candidateState = phaseState(candidate, now);

            return (
              <button
                key={index}
                type="button"
                onClick={() => setSelectedPhase(index)}
                className={cn(
                  'rounded-lg border px-3 py-2 text-xs font-medium transition-colors',
                  index === activePhaseId
                    ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300'
                    : 'border-neutral-800 text-neutral-400 hover:border-neutral-700',
                )}
              >
                {candidate.isPublic ? 'Public' : 'Allowlist'} {index + 1}
                <span
                  className={cn(
                    'ml-2 inline-block h-1.5 w-1.5 rounded-full',
                    candidateState === 'live'
                      ? 'bg-emerald-400'
                      : candidateState === 'upcoming'
                        ? 'bg-amber-400'
                        : 'bg-neutral-600',
                  )}
                />
              </button>
            );
          })}
        </div>
      )}

      {/* Phase detail */}
      <dl className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <dt className="text-neutral-500">Price</dt>
          <dd className="font-medium tabular-nums">
            {phase.price === '0' ? 'Free' : `${formatPrice(phase.price)} ETH`}
          </dd>
        </div>
        <div>
          <dt className="text-neutral-500">
            {state === 'upcoming' ? 'Starts in' : state === 'live' ? 'Ends in' : 'Status'}
          </dt>
          <dd className="font-medium tabular-nums">
            {state === 'upcoming'
              ? (formatCountdown(phase.startTime * 1000) ?? 'now')
              : state === 'live'
                ? (formatCountdown(phase.endTime * 1000) ?? 'ending')
                : 'Ended'}
          </dd>
        </div>
      </dl>

      {/* Eligibility */}
      {address && !phase.isPublic && (
        <div
          className={cn(
            'rounded-lg border px-4 py-3 text-sm',
            proofLoading
              ? 'border-neutral-800 text-neutral-500'
              : proof
                ? 'border-emerald-900 bg-emerald-950/30 text-emerald-300'
                : 'border-amber-900 bg-amber-950/30 text-amber-300',
          )}
        >
          {proofLoading
            ? 'Checking allowlist…'
            : proof
              ? `You are on the allowlist. ${remaining} of ${proof.allowance} remaining.`
              : 'This wallet is not on the allowlist for this phase.'}
        </div>
      )}

      {address && phase.isPublic && remaining === 0 && (
        <div className="rounded-lg border border-amber-900 bg-amber-950/30 px-4 py-3 text-sm text-amber-300">
          You have reached the per-wallet limit for this phase.
        </div>
      )}

      {/* Quantity */}
      <div>
        <label className="label" htmlFor="quantity">
          Quantity
        </label>
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="btn-secondary h-10 w-10 p-0"
            onClick={() => setQuantity((value) => Math.max(1, value - 1))}
            disabled={quantity <= 1}
          >
            −
          </button>
          <input
            id="quantity"
            type="number"
            min={1}
            max={Math.max(1, remaining)}
            value={quantity}
            onChange={(event) => {
              const next = Number(event.target.value);
              setQuantity(Number.isFinite(next) ? Math.max(1, next) : 1);
            }}
            className="input text-center tabular-nums"
          />
          <button
            type="button"
            className="btn-secondary h-10 w-10 p-0"
            onClick={() => setQuantity((value) => Math.min(Math.max(1, remaining), value + 1))}
            disabled={quantity >= remaining}
          >
            +
          </button>
        </div>
      </div>

      {/* Total and action */}
      <div className="flex items-baseline justify-between border-t border-neutral-800 pt-4">
        <span className="text-sm text-neutral-500">Total</span>
        <span className="text-lg font-semibold tabular-nums">
          {totalCost === 0n ? 'Free' : `${formatPrice(totalCost)} ETH`}
        </span>
      </div>

      <button
        type="button"
        className="btn-primary w-full"
        onClick={handleMint}
        disabled={!canMint || isPending || isConfirming}
      >
        {!address
          ? 'Connect wallet'
          : state === 'upcoming'
            ? 'Not started'
            : state === 'ended'
              ? 'Phase ended'
              : !eligible
                ? 'Not eligible'
                : remaining === 0
                  ? 'Limit reached'
                  : isPending
                    ? 'Confirm in wallet…'
                    : isConfirming
                      ? 'Minting…'
                      : `Mint ${quantity}`}
      </button>

      {isSuccess && (
        <p className="text-center text-sm text-emerald-400">
          Minted. It will appear in your portfolio once indexed.
        </p>
      )}

      {writeError && (
        <p className="text-center text-sm text-red-400">
          {/* Wallet errors are enormous. Only the first line is ever useful to a user. */}
          {writeError.message.split('\n')[0]}
        </p>
      )}
    </div>
  );
}
