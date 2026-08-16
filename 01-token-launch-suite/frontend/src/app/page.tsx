'use client';

import {useQuery} from '@tanstack/react-query';
import Link from 'next/link';
import {api} from '@/lib/api';
import {formatCompact, formatPrice} from '@/lib/format';

function Stat({label, value, hint}: {label: string; value: string; hint?: string}) {
  return (
    <div className="card">
      <p className="text-xs uppercase tracking-wide text-neutral-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-neutral-600">{hint}</p>}
    </div>
  );
}

export default function HomePage() {
  const {data: token} = useQuery({queryKey: ['token'], queryFn: api.token});
  const {data: staking} = useQuery({queryKey: ['stakingStats'], queryFn: api.stakingStats});
  const {data: airdrop} = useQuery({queryKey: ['airdropStats'], queryFn: api.airdropStats});

  const symbol = token?.symbol ?? 'PRJ';

  return (
    <div className="space-y-12">
      <section className="space-y-3">
        <h1 className="text-4xl font-semibold tracking-tight">{token?.name ?? 'Project Token'}</h1>
        <p className="max-w-2xl text-neutral-400">
          A capped governance token with a gas-efficient Merkle airdrop, team vesting with cliffs,
          an ERC-4626 staking vault and on-chain governance behind a timelock. Every privileged
          role is held by the timelock, not by a person.
        </p>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Supply"
          value={token ? formatCompact(token.totalSupply) : '-'}
          hint={token ? `of ${formatCompact(token.cap)} cap` : undefined}
        />
        <Stat
          label="Staked"
          value={staking ? `${formatCompact(staking.totalAssets)} ${symbol}` : '-'}
          hint={staking ? `${staking.stakerCount} stakers` : undefined}
        />
        <Stat
          label="Staking APR"
          value={staking ? `${(staking.aprBps / 100).toFixed(2)}%` : '-'}
          hint="From the current reward stream"
        />
        <Stat
          label="Airdrop claimed"
          value={
            airdrop && airdrop.entryCount > 0
              ? `${Math.round((airdrop.claimedCount / airdrop.entryCount) * 100)}%`
              : '-'
          }
          hint={airdrop ? `${airdrop.claimedCount} of ${airdrop.entryCount} wallets` : undefined}
        />
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        {[
          {
            href: '/claim',
            title: 'Claim your airdrop',
            body: 'Merkle-verified claims with state packed into a bitmap, so each claim after the first in a 256-address block costs a fraction of a normal storage write.',
          },
          {
            href: '/vesting',
            title: 'Track your vesting',
            body: 'Linear unlocks with cliffs, charted from the contract’s own vesting function so the curve cannot promise what the contract will not pay.',
          },
          {
            href: '/stake',
            title: 'Stake for yield',
            body: 'An ERC-4626 vault with streamed rewards, so a deposit made the moment a reward arrives cannot capture a share of it.',
          },
          {
            href: '/governance',
            title: 'Vote on proposals',
            body: 'Voting power is snapshotted when a vote opens, and approved actions wait out a timelock before they can run.',
          },
        ].map((card) => (
          <Link
            key={card.href}
            href={card.href}
            className="card space-y-2 transition-colors hover:border-neutral-700"
          >
            <h2 className="font-medium">{card.title}</h2>
            <p className="text-sm text-neutral-400">{card.body}</p>
          </Link>
        ))}
      </section>

      {token && (
        <section className="card space-y-3">
          <h2 className="font-medium">Supply</h2>
          <div className="h-2 overflow-hidden rounded-full bg-neutral-800">
            <div
              className="h-full rounded-full bg-indigo-500"
              style={{
                width: `${Math.min(100, (Number(BigInt(token.totalSupply) / 10n ** 18n) / Number(BigInt(token.cap) / 10n ** 18n)) * 100)}%`,
              }}
            />
          </div>
          <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-neutral-500">Circulating</dt>
              <dd className="tabular-nums">{formatPrice(token.totalSupply)}</dd>
            </div>
            <div>
              <dt className="text-neutral-500">Cap</dt>
              <dd className="tabular-nums">{formatPrice(token.cap)}</dd>
            </div>
            <div>
              <dt className="text-neutral-500">Minting</dt>
              <dd className={token.mintingFinished ? 'text-emerald-400' : 'text-neutral-300'}>
                {token.mintingFinished ? 'Permanently closed' : 'Open, governed by timelock'}
              </dd>
            </div>
          </dl>
        </section>
      )}
    </div>
  );
}
