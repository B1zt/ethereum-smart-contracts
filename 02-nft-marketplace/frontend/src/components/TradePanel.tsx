'use client';

import {useQueryClient} from '@tanstack/react-query';
import {useCallback, useEffect, useState} from 'react';
import {useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract} from 'wagmi';
import {useSignOrder} from '@/hooks/useSignOrder';
import type {ApiOrder} from '@/lib/api';
import {cn} from '@/lib/cn';
import {collectionAbi, contracts, erc20Abi, marketplaceAbi} from '@/lib/contracts';
import {formatPrice, formatPriceWithSymbol, parseAmount} from '@/lib/format';
import {buildListing, buildOffer, deserializeOrder} from '@/lib/orders';

const DURATIONS = [
  {label: '1 day', seconds: 86_400},
  {label: '3 days', seconds: 259_200},
  {label: '7 days', seconds: 604_800},
  {label: '30 days', seconds: 2_592_000},
];

interface TradePanelProps {
  collection: string;
  tokenId: string;
  owner: string | null;
  listings: ApiOrder[];
  offers: ApiOrder[];
}

export function TradePanel({collection, tokenId, owner, listings, offers}: TradePanelProps) {
  const {address} = useAccount();
  const queryClient = useQueryClient();

  const isOwner = Boolean(address && owner && address.toLowerCase() === owner.toLowerCase());
  const bestListing = listings[0] ?? null;
  const bestOffer = offers[0] ?? null;

  // Stable identity, so the effects in the child boxes that depend on it do not refire every render.
  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({queryKey: ['token', collection, tokenId]});
  }, [queryClient, collection, tokenId]);

  return (
    <div className="space-y-4">
      {bestListing && (
        <BuyBox listing={bestListing} isOwner={isOwner} onDone={invalidate} />
      )}

      {isOwner ? (
        <ListBox collection={collection} tokenId={tokenId} onDone={invalidate} />
      ) : (
        <OfferBox collection={collection} tokenId={tokenId} onDone={invalidate} />
      )}

      {isOwner && bestOffer && (
        <AcceptOfferBox offer={bestOffer} onDone={invalidate} />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- buy --- */

function BuyBox({
  listing,
  isOwner,
  onDone,
}: {
  listing: ApiOrder;
  isOwner: boolean;
  onDone: () => void;
}) {
  const {address} = useAccount();
  const {writeContract, data: hash, isPending, error} = useWriteContract();
  const {isLoading: confirming, isSuccess} = useWaitForTransactionReceipt({hash});

  // In an effect, not during render. Invalidating a query from the render body schedules a state
  // update mid-render, which React turns into an infinite loop.
  useEffect(() => {
    if (isSuccess) onDone();
  }, [isSuccess, onDone]);

  const isNative = listing.currency === '0x0000000000000000000000000000000000000000';
  const order = deserializeOrder(listing as unknown as Record<string, string>);

  const handleBuy = () => {
    writeContract({
      address: contracts.marketplace,
      abi: marketplaceAbi,
      functionName: 'fulfillListing',
      args: [order, listing.signature as `0x${string}`, 1n],
      // Native listings are paid with msg.value; ERC-20 listings must send exactly zero, which the
      // contract enforces with `UnexpectedNativePayment`.
      value: isNative ? BigInt(listing.price) : 0n,
    });
  };

  return (
    <div className="card space-y-4">
      <div className="flex items-baseline justify-between">
        <span className="text-sm text-neutral-500">Current price</span>
        <span className="text-2xl font-semibold tabular-nums">
          {formatPriceWithSymbol(listing.price, listing.currency)}
        </span>
      </div>

      <button
        type="button"
        className="btn-primary w-full"
        onClick={handleBuy}
        disabled={!address || isOwner || isPending || confirming}
      >
        {!address
          ? 'Connect wallet'
          : isOwner
            ? 'You own this'
            : isPending
              ? 'Confirm in wallet…'
              : confirming
                ? 'Buying…'
                : 'Buy now'}
      </button>

      {error && <p className="text-sm text-red-400">{error.message.split('\n')[0]}</p>}
    </div>
  );
}

/* --------------------------------------------------------------- list --- */

function ListBox({
  collection,
  tokenId,
  onDone,
}: {
  collection: string;
  tokenId: string;
  onDone: () => void;
}) {
  const {address} = useAccount();
  const [price, setPrice] = useState('');
  const [duration, setDuration] = useState(DURATIONS[2]!.seconds);
  const {status, error, signAndSubmit, reset} = useSignOrder();

  // The marketplace must be an approved operator before a listing can settle. This is the one
  // on-chain step a seller cannot avoid, and it is a one-time cost per collection.
  const {data: approved, refetch: refetchApproval} = useReadContract({
    address: collection as `0x${string}`,
    abi: collectionAbi,
    functionName: 'isApprovedForAll',
    args: address ? [address, contracts.marketplace] : undefined,
    query: {enabled: Boolean(address)},
  });

  const {writeContract, data: approvalHash, isPending: approving} = useWriteContract();
  const {isLoading: confirmingApproval, isSuccess: approvalConfirmed} =
    useWaitForTransactionReceipt({hash: approvalHash, query: {enabled: Boolean(approvalHash)}});

  useEffect(() => {
    if (approvalConfirmed) void refetchApproval();
  }, [approvalConfirmed, refetchApproval]);

  const priceWei = parseAmount(price);
  const canList = Boolean(address) && approved === true && priceWei !== null && priceWei > 0n;

  const handleApprove = () => {
    writeContract({
      address: collection as `0x${string}`,
      abi: collectionAbi,
      functionName: 'setApprovalForAll',
      args: [contracts.marketplace, true],
    });
  };

  const handleList = async () => {
    if (!address || priceWei === null) return;

    const order = await signAndSubmit((nonce) =>
      buildListing({
        maker: address,
        collection: collection as `0x${string}`,
        tokenId: BigInt(tokenId),
        priceWei,
        durationSeconds: duration,
        nonce,
      }),
    );

    if (order) {
      setPrice('');
      onDone();
    }
  };

  return (
    <div className="card space-y-4">
      <h3 className="font-medium">List for sale</h3>

      <div>
        <label className="label" htmlFor="list-price">
          Price (ETH)
        </label>
        <input
          id="list-price"
          className="input tabular-nums"
          placeholder="0.00"
          inputMode="decimal"
          value={price}
          onChange={(event) => {
            setPrice(event.target.value);
            reset();
          }}
        />
      </div>

      <div>
        <span className="label">Duration</span>
        <div className="grid grid-cols-4 gap-2">
          {DURATIONS.map((option) => (
            <button
              key={option.seconds}
              type="button"
              onClick={() => setDuration(option.seconds)}
              className={cn(
                'rounded-lg border px-2 py-2 text-xs transition-colors',
                duration === option.seconds
                  ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300'
                  : 'border-neutral-800 text-neutral-400 hover:border-neutral-700',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {approved === false ? (
        <>
          <button
            type="button"
            className="btn-primary w-full"
            onClick={handleApprove}
            disabled={approving || confirmingApproval}
          >
            {approving || confirmingApproval ? 'Approving…' : 'Approve marketplace'}
          </button>
          <p className="text-xs text-neutral-500">
            One-time approval per collection. After this, listing is gasless.
          </p>
        </>
      ) : (
        <>
          <button
            type="button"
            className="btn-primary w-full"
            onClick={() => void handleList()}
            disabled={!canList || status === 'signing' || status === 'submitting'}
          >
            {status === 'signing'
              ? 'Sign in wallet…'
              : status === 'submitting'
                ? 'Publishing…'
                : 'List'}
          </button>
          <p className="text-xs text-neutral-500">
            Signing is free. No transaction is sent until someone buys.
          </p>
        </>
      )}

      {status === 'success' && <p className="text-sm text-emerald-400">Listed.</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}

/* -------------------------------------------------------------- offer --- */

function OfferBox({
  collection,
  tokenId,
  onDone,
}: {
  collection: string;
  tokenId: string;
  onDone: () => void;
}) {
  const {address} = useAccount();
  const [price, setPrice] = useState('');
  const [duration, setDuration] = useState(DURATIONS[1]!.seconds);
  const {status, error, signAndSubmit, reset} = useSignOrder();

  const priceWei = parseAmount(price);

  // Offers are denominated in WETH because a signature cannot escrow native ETH. The allowance has
  // to cover the offer, otherwise the order book will reject it with INSUFFICIENT_ALLOWANCE.
  const {data: allowance, refetch: refetchAllowance} = useReadContract({
    address: contracts.weth,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address ? [address, contracts.marketplace] : undefined,
    query: {enabled: Boolean(address)},
  });

  const {writeContract, data: approvalHash, isPending: approving} = useWriteContract();
  const {isLoading: confirmingApproval, isSuccess: approvalConfirmed} =
    useWaitForTransactionReceipt({hash: approvalHash, query: {enabled: Boolean(approvalHash)}});

  useEffect(() => {
    if (approvalConfirmed) void refetchAllowance();
  }, [approvalConfirmed, refetchAllowance]);

  const needsApproval = priceWei !== null && (allowance ?? 0n) < priceWei;

  const handleApprove = () => {
    writeContract({
      address: contracts.weth,
      abi: erc20Abi,
      functionName: 'approve',
      args: [contracts.marketplace, 2n ** 256n - 1n],
    });
  };

  const handleOffer = async () => {
    if (!address || priceWei === null) return;

    const order = await signAndSubmit((nonce) =>
      buildOffer({
        maker: address,
        collection: collection as `0x${string}`,
        tokenId: BigInt(tokenId),
        priceWei,
        durationSeconds: duration,
        nonce,
        currency: contracts.weth,
      }),
    );

    if (order) {
      setPrice('');
      onDone();
    }
  };

  return (
    <div className="card space-y-4">
      <h3 className="font-medium">Make an offer</h3>

      <div>
        <label className="label" htmlFor="offer-price">
          Offer (WETH)
        </label>
        <input
          id="offer-price"
          className="input tabular-nums"
          placeholder="0.00"
          inputMode="decimal"
          value={price}
          onChange={(event) => {
            setPrice(event.target.value);
            reset();
          }}
        />
      </div>

      <div>
        <span className="label">Duration</span>
        <div className="grid grid-cols-4 gap-2">
          {DURATIONS.map((option) => (
            <button
              key={option.seconds}
              type="button"
              onClick={() => setDuration(option.seconds)}
              className={cn(
                'rounded-lg border px-2 py-2 text-xs transition-colors',
                duration === option.seconds
                  ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300'
                  : 'border-neutral-800 text-neutral-400 hover:border-neutral-700',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {needsApproval ? (
        <button
          type="button"
          className="btn-primary w-full"
          onClick={handleApprove}
          disabled={!address || approving || confirmingApproval}
        >
          {approving || confirmingApproval ? 'Approving…' : 'Approve WETH'}
        </button>
      ) : (
        <button
          type="button"
          className="btn-primary w-full"
          onClick={() => void handleOffer()}
          disabled={
            !address || priceWei === null || priceWei === 0n || status === 'signing' || status === 'submitting'
          }
        >
          {status === 'signing'
            ? 'Sign in wallet…'
            : status === 'submitting'
              ? 'Publishing…'
              : 'Make offer'}
        </button>
      )}

      {status === 'success' && <p className="text-sm text-emerald-400">Offer published.</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}

/* ------------------------------------------------------- accept offer --- */

function AcceptOfferBox({offer, onDone}: {offer: ApiOrder; onDone: () => void}) {
  const {writeContract, data: hash, isPending, error} = useWriteContract();
  const {isLoading: confirming, isSuccess} = useWaitForTransactionReceipt({hash});

  useEffect(() => {
    if (isSuccess) onDone();
  }, [isSuccess, onDone]);

  const order = deserializeOrder(offer as unknown as Record<string, string>);

  return (
    <div className="card space-y-3">
      <div className="flex items-baseline justify-between">
        <span className="text-sm text-neutral-500">Best offer</span>
        <span className="text-lg font-semibold tabular-nums">
          {formatPrice(offer.price)} WETH
        </span>
      </div>

      <button
        type="button"
        className="btn-secondary w-full"
        onClick={() =>
          writeContract({
            address: contracts.marketplace,
            abi: marketplaceAbi,
            functionName: 'acceptOffer',
            args: [order, offer.signature as `0x${string}`, 1n],
          })
        }
        disabled={isPending || confirming}
      >
        {isPending ? 'Confirm in wallet…' : confirming ? 'Accepting…' : 'Accept offer'}
      </button>

      {error && <p className="text-sm text-red-400">{error.message.split('\n')[0]}</p>}
    </div>
  );
}
