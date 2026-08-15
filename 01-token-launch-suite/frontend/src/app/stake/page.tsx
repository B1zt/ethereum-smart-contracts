'use client';

import {useQuery, useQueryClient} from '@tanstack/react-query';
import {useEffect, useState} from 'react';
import {useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract} from 'wagmi';
import {api} from '@/lib/api';
import {cn} from '@/lib/cn';
import {contracts, tokenAbi, vaultAbi} from '@/lib/contracts';
import {formatCountdown, formatPrice, parseAmount} from '@/lib/format';

export default function StakePage() {
  const {address} = useAccount();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<'stake' | 'unstake'>('stake');
  const [amount, setAmount] = useState('');

  const {data: token} = useQuery({queryKey: ['token'], queryFn: api.token});

  const {data: stats} = useQuery({
    queryKey: ['stakingStats'],
    queryFn: api.stakingStats,
    refetchInterval: 15_000,
  });

  const {data: position} = useQuery({
    queryKey: ['stakePosition', address],
    queryFn: () => api.stakePosition(address!),
    enabled: Boolean(address),
    refetchInterval: 15_000,
  });

  const {data: balance, refetch: refetchBalance} = useReadContract({
    address: contracts.token,
    abi: tokenAbi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: {enabled: Boolean(address)},
  });

  const {data: allowance, refetch: refetchAllowance} = useReadContract({
    address: contracts.token,
    abi: tokenAbi,
    functionName: 'allowance',
    args: address ? [address, contracts.vault] : undefined,
    query: {enabled: Boolean(address)},
  });

  const {writeContract, data: hash, isPending, error, reset} = useWriteContract();
  const {isLoading: confirming, isSuccess} = useWaitForTransactionReceipt({hash});

  useEffect(() => {
    if (!isSuccess) return;

    setAmount('');
    void refetchBalance();
    void refetchAllowance();
    void queryClient.invalidateQueries({queryKey: ['stakePosition', address]});
    void queryClient.invalidateQueries({queryKey: ['stakingStats']});
  }, [isSuccess, queryClient, address, refetchBalance, refetchAllowance]);

  const symbol = token?.symbol ?? 'PRJ';
  const parsed = parseAmount(amount);
  const busy = isPending || confirming;

  const shares = BigInt(position?.shares ?? '0');
  const staked = BigInt(position?.assets ?? '0');
  const gain = BigInt(position?.unrealisedGain ?? '0');
  const cooldown = position?.cooldownRemaining ?? 0;

  const needsApproval = tab === 'stake' && parsed !== null && (allowance ?? 0n) < parsed;
  const insufficientBalance = tab === 'stake' && parsed !== null && parsed > (balance ?? 0n);
  const insufficientStake = tab === 'unstake' && parsed !== null && parsed > staked;

  const max = tab === 'stake' ? (balance ?? 0n) : staked;

  const handleSubmit = () => {
    if (!address || parsed === null || parsed === 0n) return;

    if (needsApproval) {
      writeContract({
        address: contracts.token,
        abi: tokenAbi,
        functionName: 'approve',
        args: [contracts.vault, 2n ** 256n - 1n],
      });
      return;
    }

    if (tab === 'stake') {
      writeContract({
        address: contracts.vault,
        abi: vaultAbi,
        functionName: 'deposit',
        args: [parsed, address],
      });
      return;
    }

    // Redeeming by shares rather than withdrawing by assets avoids a rounding mismatch: the share
    // price moves between the quote and the transaction, and a "max" withdrawal expressed in assets
    // can end up one wei short and revert.
    const sharesToRedeem = staked === 0n ? 0n : (parsed * shares) / staked;

    writeContract({
      address: contracts.vault,
      abi: vaultAbi,
      functionName: 'redeem',
      args: [sharesToRedeem > shares ? shares : sharesToRedeem, address, address],
    });
  };

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Stake</h1>
        <p className="max-w-2xl text-neutral-400">
          An ERC-4626 vault. Rewards are streamed in linearly rather than dropped in at once, so a
          deposit made the moment a reward arrives cannot capture a share of it.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-neutral-500">Total staked</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">
            {stats ? formatPrice(stats.totalAssets) : '—'} {symbol}
          </p>
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-neutral-500">Current APR</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">
            {stats ? `${(stats.aprBps / 100).toFixed(2)}%` : '—'}
          </p>
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-neutral-500">Stakers</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{stats?.stakerCount ?? '—'}</p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="card space-y-4">
          <h2 className="font-medium">Your position</h2>

          {!address ? (
            <p className="py-8 text-center text-neutral-500">Connect a wallet.</p>
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <dt className="text-neutral-500">Staked</dt>
                  <dd className="text-xl font-semibold tabular-nums">
                    {formatPrice(staked)} {symbol}
                  </dd>
                </div>
                <div>
                  <dt className="text-neutral-500">Unrealised gain</dt>
                  <dd
                    className={cn(
                      'text-xl font-semibold tabular-nums',
                      gain > 0n ? 'text-emerald-400' : 'text-neutral-300',
                    )}
                  >
                    {gain > 0n ? '+' : ''}
                    {formatPrice(gain)} {symbol}
                  </dd>
                </div>
                <div>
                  <dt className="text-neutral-500">Shares</dt>
                  <dd className="tabular-nums">{formatPrice(shares)}</dd>
                </div>
                <div>
                  <dt className="text-neutral-500">Wallet balance</dt>
                  <dd className="tabular-nums">{formatPrice(balance ?? 0n)}</dd>
                </div>
              </dl>

              {cooldown > 0 && (
                <p className="rounded-lg border border-amber-900 bg-amber-950/30 px-3 py-2 text-sm text-amber-300">
                  Withdrawals unlock in {formatCountdown(Date.now() + cooldown * 1000) ?? 'moments'}.
                </p>
              )}

              {(position?.history.length ?? 0) > 0 && (
                <div className="border-t border-neutral-800 pt-4">
                  <h3 className="mb-2 text-sm text-neutral-500">Recent activity</h3>
                  <ul className="divide-y divide-neutral-800 text-sm">
                    {position!.history.slice(0, 5).map((event) => (
                      <li key={event.id} className="flex justify-between py-2">
                        <span className={event.kind === 'DEPOSIT' ? 'text-emerald-400' : 'text-neutral-400'}>
                          {event.kind === 'DEPOSIT' ? 'Staked' : 'Unstaked'}
                        </span>
                        <span className="tabular-nums">{formatPrice(event.assets)} {symbol}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>

        <div className="card space-y-4">
          <div className="flex gap-1 rounded-lg bg-neutral-900 p-1">
            {(['stake', 'unstake'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setTab(value);
                  setAmount('');
                  reset();
                }}
                className={cn(
                  'flex-1 rounded-md px-3 py-2 text-sm font-medium capitalize transition-colors',
                  tab === value ? 'bg-neutral-800 text-white' : 'text-neutral-500 hover:text-neutral-300',
                )}
              >
                {value}
              </button>
            ))}
          </div>

          <div>
            <div className="mb-1.5 flex items-baseline justify-between">
              <label className="label mb-0" htmlFor="amount">
                Amount
              </label>
              <button
                type="button"
                className="text-xs text-indigo-400 hover:text-indigo-300"
                onClick={() => setAmount(formatPrice(max))}
              >
                Max {formatPrice(max)}
              </button>
            </div>
            <input
              id="amount"
              className="input tabular-nums"
              placeholder="0.00"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </div>

          <button
            type="button"
            className="btn-primary w-full"
            onClick={handleSubmit}
            disabled={
              !address ||
              parsed === null ||
              parsed === 0n ||
              insufficientBalance ||
              insufficientStake ||
              (tab === 'unstake' && cooldown > 0) ||
              busy
            }
          >
            {!address
              ? 'Connect wallet'
              : insufficientBalance
                ? 'Insufficient balance'
                : insufficientStake
                  ? 'Insufficient stake'
                  : tab === 'unstake' && cooldown > 0
                    ? 'Cooling down'
                    : needsApproval
                      ? busy
                        ? 'Approving…'
                        : `Approve ${symbol}`
                      : busy
                        ? tab === 'stake'
                          ? 'Staking…'
                          : 'Unstaking…'
                        : tab === 'stake'
                          ? 'Stake'
                          : 'Unstake'}
          </button>

          {needsApproval && (
            <p className="text-xs text-neutral-500">
              One-time approval. Staking after this is a single transaction.
            </p>
          )}

          {error && <p className="text-sm text-red-400">{error.message.split('\n')[0]}</p>}
        </div>
      </div>
    </div>
  );
}
