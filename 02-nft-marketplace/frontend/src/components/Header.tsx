'use client';

import {ConnectButton} from '@rainbow-me/rainbowkit';
import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {cn} from '@/lib/cn';
import {contracts} from '@/lib/contracts';

const links = [
  {href: '/', label: 'Mint'},
  {href: `/collection/${contracts.collection}`, label: 'Explore'},
  {href: '/auctions', label: 'Auctions'},
  {href: '/portfolio', label: 'Portfolio'},
];

export function Header() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-neutral-800 bg-neutral-950/80 backdrop-blur">
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-4 py-4">
        <div className="flex items-center gap-8">
          <Link href="/" className="text-lg font-semibold tracking-tight">
            B1zt<span className="text-indigo-400">.market</span>
          </Link>

          <nav className="hidden items-center gap-1 md:flex">
            {links.map((link) => {
              const active =
                link.href === '/' ? pathname === '/' : pathname.startsWith(link.href.split('?')[0]!);

              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={cn(
                    'rounded-md px-3 py-2 text-sm transition-colors',
                    active
                      ? 'bg-neutral-800 text-white'
                      : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100',
                  )}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>
        </div>

        <ConnectButton showBalance={false} chainStatus="icon" />
      </div>
    </header>
  );
}
