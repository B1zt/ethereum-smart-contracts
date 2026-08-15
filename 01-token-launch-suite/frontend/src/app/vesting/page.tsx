'use client';

import {useQuery, useQueryClient} from '@tanstack/react-query';
import {useEffect} from 'react';
import {useAccount, useWaitForTransactionReceipt, useWriteContract} from 'wagmi';
import {UnlockCurve} from '@/components/UnlockCurve';
import {api, type VestingSchedule} from '@/lib/api';
import {cn} from '@/lib/cn';
import {contracts, vestingAbi} from '@/lib/contracts';
import {formatCountdown, formatPrice, formatRelativeTime} from '@/lib/format';

function ScheduleCard({
  schedule,
  symbol,
  onRelease,
  busy,
}: {
  schedule: VestingSchedule;
  symbol: string;
  onRelease: (id: string) => void;
  busy: boolean;
}) {
  const total = BigInt(schedule.total);
  const released = BigInt(schedule.released);
  const releasable = BigInt(schedule.releasable);

  const releasedPercent = total === 0n ? 0 : Number((released * 10_000n) / total) / 100;
  const vestedPercent =
    total === 0n ? 0 : Number(((released + releasable) * 10_000n) / total) / 100;

  const start = new Date(schedule.startTime).getTime();
  const cliffEnd = start + schedule.cliffSeconds * 1000;
  const end = start + schedule.durationSeconds * 1000;

  const beforeCliff = Date.now() < cliffEnd;

  return (
    <div className="card space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-medium">Schedule #{schedule.id}</h3>
          <p className="text-sm text-neutral-500">
            {formatPrice(schedule.total)} {symbol} over{' '}
            {Math.round(schedule.durationSeconds / 86_400)} days
            {schedule.cliffSeconds > 0
              ? `, ${Math.round(schedule.cliffSeconds / 86_400)} day cliff`
              : ''}
          </p>
        </div>

        <div className="flex gap-2">
          {schedule.revoked && (
            <span className="rounded-full bg-red-500/15 px-2.5 py-1 text-xs text-red-300">
              Revoked
            </span>
          )}
          {schedule.revocable && !schedule.revoked && (
            <span className="rounded-full bg-amber-500/15 px-2.5 py-1 text-xs text-amber-300">
              Revocable
            </span>
          )}
        </div>
      </div>

      {/* Two-tone bar: released is solid, vested-but-unclaimed is lighter. */}
      <div>
        <div className="relative h-2 overflow-hidden rounded-full bg-neutral-800">
          <div
            className="absolute inset-y-0 left-0 bg-indigo-500/40"
            style={{width: `${vestedPercent}%`}}
          />
          <div
            className="absolute inset-y-0 left-0 bg-indigo-500"
            style={{width: `${releasedPercent}%`}}
          />
        </div>
        <div className="mt-2 flex justify-between text-xs text-neutral-500">
          <span>{formatPrice(schedule.released)} claimed</span>
          <span>{formatPrice(schedule.total)} total</span>
        </div>
      </div>

      <UnlockCurve scheduleId={schedule.id} />

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-800 pt-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-neutral-500">Claimable now</p>
          <p className="text-xl font-semibold tabular-nums">
            {formatPrice(schedule.releasable)} {symbol}
          </p>
          {beforeCliff && (
            <p className="mt-1 text-xs text-amber-400">
              Cliff ends in {formatCountdown(cliffEnd) ?? 'now'}
            </p>
          )}
          {!beforeCliff && Date.now() < end && (
            <p className="mt-1 text-xs text-neutral-500">
              Fully vested in {formatCountdown(end) ?? 'now'}
            </p>
          )}
        </div>

        <button
          type="button"
          className={cn('btn-primary', releasable === 0n && 'opacity-50')}
          onClick={() => onRelease(schedule.id)}
          disabled={releasable === 0n || busy}
        >
          {busy ? 'Claiming…' : 'Claim'}
        </button>
      </div>

      {schedule.releases.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-neutral-500 hover:text-neutral-300">
            {schedule.releases.length} previous claim{schedule.releases.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-2 divide-y divide-neutral-800">
            {schedule.releases.map((release) => (
              <li key={release.id} className="flex justify-between py-2">
                <span className="text-neutral-500">{formatRelativeTime(release.blockTime)}</span>
                <span className="tabular-nums">{formatPrice(release.amount)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export default function VestingPage() {
  const {address} = useAccount();
  const queryClient = useQueryClient();

  const {data: token} = useQuery({queryKey: ['token'], queryFn: api.token});

  const {data, isLoading} = useQuery({
    queryKey: ['vesting', address],
    queryFn: () => api.vesting(address!),
    enabled: Boolean(address),
    refetchInterval: 30_000,
  });

  const {writeContract, data: hash, isPending, error} = useWriteContract();
  const {isLoading: confirming, isSuccess} = useWaitForTransactionReceipt({hash});

  useEffect(() => {
    if (isSuccess) void queryClient.invalidateQueries({queryKey: ['vesting', address]});
  }, [isSuccess, queryClient, address]);

  const symbol = token?.symbol ?? 'PRJ';
  const busy = isPending || confirming;

  const releaseOne = (id: string) => {
    writeContract({
      address: contracts.vesting,
      abi: vestingAbi,
      functionName: 'release',
      args: [BigInt(id)],
    });
  };

  const releaseAll = () => {
    const ids = (data?.schedules ?? [])
      .filter((schedule) => BigInt(schedule.releasable) > 0n)
      .map((schedule) => BigInt(schedule.id));

    if (ids.length === 0) return;

    writeContract({
      address: contracts.vesting,
      abi: vestingAbi,
      functionName: 'releaseMany',
      args: [ids],
    });
  };

  const totalReleasable = BigInt(data?.totalReleasable ?? '0');

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">Vesting</h1>
          <p className="max-w-2xl text-neutral-400">
            Tokens vest linearly from the schedule start. Crossing a cliff unlocks everything
            accrued during it at once.
          </p>
        </div>

        {totalReleasable > 0n && (
          <button type="button" className="btn-primary" onClick={releaseAll} disabled={busy}>
            {busy ? 'Claiming…' : `Claim all ${formatPrice(totalReleasable)} ${symbol}`}
          </button>
        )}
      </header>

      {error && <p className="text-sm text-red-400">{error.message.split('\n')[0]}</p>}

      {!address ? (
        <p className="py-24 text-center text-neutral-500">
          Connect a wallet to see your vesting schedules.
        </p>
      ) : isLoading ? (
        <div className="h-64 animate-pulse rounded-xl bg-neutral-900" />
      ) : (data?.schedules.length ?? 0) === 0 ? (
        <p className="py-24 text-center text-neutral-600">
          No vesting schedules for this wallet.
        </p>
      ) : (
        <div className="space-y-6">
          {data!.schedules.map((schedule) => (
            <ScheduleCard
              key={schedule.id}
              schedule={schedule}
              symbol={symbol}
              onRelease={releaseOne}
              busy={busy}
            />
          ))}
        </div>
      )}
    </div>
  );
}
