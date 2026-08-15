import Link from 'next/link';
import type {ApiOrder, ApiTokenMetadata} from '@/lib/api';
import {formatPriceWithSymbol} from '@/lib/format';

interface TokenCardProps {
  token: ApiTokenMetadata & {listing: ApiOrder | null};
}

export function TokenCard({token}: TokenCardProps) {
  const image = token.thumbnailUrl ?? token.imageUrl;

  return (
    <Link
      href={`/token/${token.collection}/${token.tokenId}`}
      className="group overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/50 transition-colors hover:border-neutral-700"
    >
      <div className="aspect-square overflow-hidden bg-neutral-900">
        {image ? (
          // Plain img rather than next/image: token art is served from arbitrary IPFS gateways, and
          // the optimiser needs every host allowlisted up front, which is not knowable here.
          <img
            src={image}
            alt={token.name ?? `#${token.tokenId}`}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-neutral-600">
            Unrevealed
          </div>
        )}
      </div>

      <div className="space-y-1 p-3">
        <p className="truncate text-sm font-medium">{token.name ?? `#${token.tokenId}`}</p>

        {token.listing ? (
          <p className="text-sm tabular-nums text-neutral-300">
            {formatPriceWithSymbol(token.listing.unitPrice, token.listing.currency)}
          </p>
        ) : (
          <p className="text-sm text-neutral-600">Not listed</p>
        )}
      </div>
    </Link>
  );
}
