'use client';

import {useCallback, useState} from 'react';
import {useAccount, useChainId, useReadContract, useSignTypedData} from 'wagmi';
import {api, ApiError} from '@/lib/api';
import {contracts, marketplaceAbi} from '@/lib/contracts';
import {
  buildDomain,
  ORDER_TYPES,
  REJECTION_MESSAGES,
  serializeOrder,
  type Order,
} from '@/lib/orders';

interface SignOrderState {
  status: 'idle' | 'signing' | 'submitting' | 'success' | 'error';
  error: string | null;
  orderHash: string | null;
}

/**
 * Sign an order and publish it to the order book.
 *
 * The whole flow costs the maker nothing: no transaction, no gas, just a wallet signature. That is
 * the point of the design, and it is worth surfacing in the UI because users expect listing to cost
 * gas and are reassured when it does not.
 *
 * The maker's on-chain nonce is read fresh rather than cached. A stale nonce produces a signature
 * the contract will reject, and the order book will refuse it with `STALE_NONCE`, so the round trip
 * is wasted. Reading it costs one `eth_call`.
 */
export function useSignOrder() {
  const {address} = useAccount();
  const chainId = useChainId();
  const {signTypedDataAsync} = useSignTypedData();

  const [state, setState] = useState<SignOrderState>({
    status: 'idle',
    error: null,
    orderHash: null,
  });

  const {data: nonce, refetch: refetchNonce} = useReadContract({
    address: contracts.marketplace,
    abi: marketplaceAbi,
    functionName: 'nonces',
    args: address ? [address] : undefined,
    query: {enabled: Boolean(address)},
  });

  const signAndSubmit = useCallback(
    async (buildOrder: (nonce: bigint) => Order) => {
      if (!address) {
        setState({status: 'error', error: 'Connect a wallet first.', orderHash: null});
        return null;
      }

      setState({status: 'signing', error: null, orderHash: null});

      try {
        // Re-read rather than trusting the cached value: the user may have hit "cancel all orders"
        // in another tab since this component mounted.
        const {data: freshNonce} = await refetchNonce();
        const order = buildOrder(freshNonce ?? nonce ?? 0n);

        const signature = await signTypedDataAsync({
          domain: buildDomain(chainId, contracts.marketplace),
          types: ORDER_TYPES,
          primaryType: 'Order',
          message: order,
        });

        setState({status: 'submitting', error: null, orderHash: null});

        const result = await api.submitOrder(serializeOrder(order), signature);

        setState({status: 'success', error: null, orderHash: result.order.hash});
        return result.order;
      } catch (error) {
        setState({status: 'error', error: describeError(error), orderHash: null});
        return null;
      }
    },
    [address, chainId, nonce, refetchNonce, signTypedDataAsync],
  );

  const reset = useCallback(() => {
    setState({status: 'idle', error: null, orderHash: null});
  }, []);

  return {...state, nonce, signAndSubmit, reset};
}

/**
 * Turn a thrown value into something worth showing a user.
 *
 * The API returns machine-readable rejection codes; those get mapped to plain sentences. A wallet
 * rejection is not an error worth alarming anyone about, so it gets its own neutral message.
 */
function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as {reasons?: string[]} | null;
    const reasons = body?.reasons ?? [];

    if (reasons.length > 0) {
      return reasons.map((reason) => REJECTION_MESSAGES[reason] ?? reason).join(' ');
    }

    return error.message;
  }

  if (error instanceof Error) {
    if (/user rejected|denied|rejected the request/i.test(error.message)) {
      return 'Signature cancelled.';
    }
    return error.message;
  }

  return 'Something went wrong.';
}
