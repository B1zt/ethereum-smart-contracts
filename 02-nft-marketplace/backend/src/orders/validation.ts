import {hashTypedData, type Hex} from 'viem';
import {collectionAbi, erc1155Abi, erc20Abi, marketplaceAbi} from '../chain/abis.js';
import {publicClient} from '../chain/client.js';
import {config} from '../config.js';
import {ORDER_TYPES, Side, TokenType, ZERO_ADDRESS, type OrderStruct} from './types.js';

/**
 * EIP-712 domain. Must match the `EIP712("B1zt Marketplace", "1")` constructor argument and the
 * deployed marketplace address.
 */
export const domain = {
  name: 'B1zt Marketplace',
  version: '1',
  chainId: config.CHAIN_ID,
  verifyingContract: config.MARKETPLACE_ADDRESS,
} as const;

/** Digest a maker signs, and the marketplace's on-chain order identifier. */
export function hashOrder(order: OrderStruct): Hex {
  return hashTypedData({
    domain,
    types: ORDER_TYPES,
    primaryType: 'Order',
    message: order,
  });
}

export type RejectionReason =
  | 'INVALID_SIGNATURE'
  | 'EXPIRED'
  | 'BAD_WINDOW'
  | 'STALE_NONCE'
  | 'CANCELLED_ON_CHAIN'
  | 'ALREADY_FILLED'
  | 'NOT_OWNER'
  | 'NOT_APPROVED'
  | 'INSUFFICIENT_BALANCE'
  | 'INSUFFICIENT_ALLOWANCE'
  | 'CURRENCY_NOT_ALLOWED'
  | 'NATIVE_OFFER'
  | 'BAD_AMOUNT';

export interface ValidationResult {
  ok: boolean;
  hash: Hex;
  reasons: RejectionReason[];
  filledAmount: bigint;
}

/**
 * Decide whether an order is worth storing and serving.
 *
 * The contract re-checks all of this at fill time, so nothing here is a security boundary. The
 * point is honesty of the order book: an order that would revert on fill should never be shown to
 * a buyer as available. Every rejection below corresponds to a specific revert in the contract.
 *
 * Signature verification uses `verifyTypedData`, which falls back to an EIP-1271 `isValidSignature`
 * call when the maker is a contract. That is what lets Safe multisigs list, matching the
 * `SignatureChecker` behaviour on-chain.
 */
export async function validateOrder(order: OrderStruct, signature: Hex): Promise<ValidationResult> {
  const hash = hashOrder(order);
  const reasons: RejectionReason[] = [];

  // Cheap, purely local checks first. No point spending RPC calls on a malformed order.
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (order.endTime <= order.startTime) reasons.push('BAD_WINDOW');
  if (order.endTime <= now) reasons.push('EXPIRED');
  if (order.amount === 0n) reasons.push('BAD_AMOUNT');
  if (order.tokenType === TokenType.ERC721 && order.amount !== 1n) reasons.push('BAD_AMOUNT');
  if (order.side === Side.Offer && order.currency === ZERO_ADDRESS) reasons.push('NATIVE_OFFER');

  if (reasons.length > 0) {
    return {ok: false, hash, reasons, filledAmount: 0n};
  }

  const isNative = order.currency === ZERO_ADDRESS;

  // These are independent reads, so they go out together and viem batches them into one multicall.
  const [signatureValid, currentNonce, cancelled, filledAmount, currencyAllowed] = await Promise.all([
    publicClient
      .verifyTypedData({
        address: order.maker,
        domain,
        types: ORDER_TYPES,
        primaryType: 'Order',
        message: order,
        signature,
      })
      .catch(() => false),
    publicClient.readContract({
      address: config.MARKETPLACE_ADDRESS,
      abi: marketplaceAbi,
      functionName: 'nonces',
      args: [order.maker],
    }),
    publicClient.readContract({
      address: config.MARKETPLACE_ADDRESS,
      abi: marketplaceAbi,
      functionName: 'cancelled',
      args: [hash],
    }),
    publicClient.readContract({
      address: config.MARKETPLACE_ADDRESS,
      abi: marketplaceAbi,
      functionName: 'filled',
      args: [hash],
    }),
    isNative
      ? Promise.resolve(true)
      : publicClient.readContract({
          address: config.MARKETPLACE_ADDRESS,
          abi: marketplaceAbi,
          functionName: 'allowedCurrency',
          args: [order.currency],
        }),
  ]);

  if (!signatureValid) reasons.push('INVALID_SIGNATURE');
  if (order.nonce !== currentNonce) reasons.push('STALE_NONCE');
  if (cancelled) reasons.push('CANCELLED_ON_CHAIN');
  if (filledAmount >= order.amount) reasons.push('ALREADY_FILLED');
  if (!currencyAllowed) reasons.push('CURRENCY_NOT_ALLOWED');

  // Whether the maker can actually deliver their side of the trade.
  const settlementReasons =
    order.side === Side.Listing
      ? await checkSellerCanDeliver(order)
      : await checkBuyerCanPay(order);

  reasons.push(...settlementReasons);

  return {ok: reasons.length === 0, hash, reasons, filledAmount};
}

/** A listing maker must own the asset and have approved the marketplace to move it. */
async function checkSellerCanDeliver(order: OrderStruct): Promise<RejectionReason[]> {
  const reasons: RejectionReason[] = [];

  try {
    if (order.tokenType === TokenType.ERC721) {
      const [owner, approvedForAll, approved] = await Promise.all([
        publicClient.readContract({
          address: order.collection,
          abi: collectionAbi,
          functionName: 'ownerOf',
          args: [order.tokenId],
        }),
        publicClient.readContract({
          address: order.collection,
          abi: collectionAbi,
          functionName: 'isApprovedForAll',
          args: [order.maker, config.MARKETPLACE_ADDRESS],
        }),
        publicClient.readContract({
          address: order.collection,
          abi: collectionAbi,
          functionName: 'getApproved',
          args: [order.tokenId],
        }),
      ]);

      if (owner.toLowerCase() !== order.maker) reasons.push('NOT_OWNER');
      // Either blanket operator approval or a single-token approval is enough.
      if (!approvedForAll && approved.toLowerCase() !== config.MARKETPLACE_ADDRESS) {
        reasons.push('NOT_APPROVED');
      }
    } else {
      const [balance, approvedForAll] = await Promise.all([
        publicClient.readContract({
          address: order.collection,
          abi: erc1155Abi,
          functionName: 'balanceOf',
          args: [order.maker, order.tokenId],
        }),
        publicClient.readContract({
          address: order.collection,
          abi: erc1155Abi,
          functionName: 'isApprovedForAll',
          args: [order.maker, config.MARKETPLACE_ADDRESS],
        }),
      ]);

      if (balance < order.amount) reasons.push('INSUFFICIENT_BALANCE');
      if (!approvedForAll) reasons.push('NOT_APPROVED');
    }
  } catch {
    // A collection that does not answer standard calls cannot be verified, so it is not listed.
    reasons.push('NOT_OWNER');
  }

  return reasons;
}

/** An offer maker must hold enough ERC-20 and have approved the marketplace to spend it. */
async function checkBuyerCanPay(order: OrderStruct): Promise<RejectionReason[]> {
  const reasons: RejectionReason[] = [];

  try {
    const [balance, allowance] = await Promise.all([
      publicClient.readContract({
        address: order.currency,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [order.maker],
      }),
      publicClient.readContract({
        address: order.currency,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [order.maker, config.MARKETPLACE_ADDRESS],
      }),
    ]);

    if (balance < order.price) reasons.push('INSUFFICIENT_BALANCE');
    if (allowance < order.price) reasons.push('INSUFFICIENT_ALLOWANCE');
  } catch {
    reasons.push('INSUFFICIENT_BALANCE');
  }

  return reasons;
}
