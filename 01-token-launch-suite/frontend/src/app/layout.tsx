import type {Metadata} from 'next';
import Link from 'next/link';
import {Header} from '@/components/Header';
import {Providers} from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'B1zt Token Suite',
  description:
    'Capped governance token with a gas-efficient Merkle airdrop, vesting, an ERC-4626 staking vault and on-chain governance behind a timelock.',
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-950 text-neutral-100 antialiased">
        <Providers>
          <Header />
          <main className="mx-auto w-full max-w-6xl px-4 py-8">{children}</main>
          <footer className="border-t border-neutral-800 py-8 text-center text-sm text-neutral-500">
            <p>
              Reference implementation.{' '}
              <Link
                href="https://github.com/B1zt/ethereum-smart-contracts"
                className="text-neutral-300 underline underline-offset-4 hover:text-white"
              >
                Source on GitHub
              </Link>
            </p>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
