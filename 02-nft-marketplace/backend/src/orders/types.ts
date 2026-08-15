import {z} from 'zod';

/**
 * EIP-712 type definition for an order.
 *
 * This must match `OrderTypes.ORDER_TYPEHASH` in the contract byte for byte, including field order.
 * If the two ever drift, every signature produced by the frontend will recover to the wrong address
 * and fills will fail with `InvalidSignature` for reasons that are painful to debug. The contract
 * test suite and this constant are the two places to change together.
 */
export const ORDER_TYPES = {
  Order: [
    {name: 'maker', type: 'address'},
    {name: 'collection', type: 'address'},
    {name: 'tokenId', type: 'uint256'},
    {name: 'amount', type: 'uint256'},
    {name: 'currency', type: 'address'},
    {name: 'price', type: 'uint256'},
    {name: 'startTime', type: 'uint256'},
    {name: 'endTime', type: 'uint256'},
    {name: 'salt', type: 'uint256'},
    {name: 'nonce', type: 'uint256'},
    {name: 'side', type: 'uint8'},
    {name: 'tokenType', type: 'uint8'},
  ],
} as const;

/** Matches the `Side` enum in the contract. */
export const Side = {Listing: 0, Offer: 1} as const;

/** Matches the `TokenType` enum in the contract. */
export const TokenType = {ERC721: 0, ERC1155: 1} as const;

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'invalid address')
  .transform((value) => value.toLowerCase() as `0x${string}`);

/**
 * A uint256 arriving over JSON.
 *
 * Accepted as a decimal string, never a number: values above 2^53 lose precision silently as a JS
 * number, and a price is exactly the kind of field where that would be a real loss.
 */
const uint256Schema = z
  .string()
  .regex(/^\d+$/, 'must be a decimal string')
  .refine((value) => BigInt(value) <= 2n ** 256n - 1n, 'exceeds uint256');

export const orderSchema = z.object({
  maker: addressSchema,
  collection: addressSchema,
  tokenId: uint256Schema,
  amount: uint256Schema,
  currency: addressSchema,
  price: uint256Schema,
  startTime: uint256Schema,
  endTime: uint256Schema,
  salt: uint256Schema,
  nonce: uint256Schema,
  side: z.union([z.literal(0), z.literal(1)]),
  tokenType: z.union([z.literal(0), z.literal(1)]),
});

export const submitOrderSchema = z.object({
  order: orderSchema,
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/, 'invalid signature'),
});

export type OrderInput = z.infer<typeof orderSchema>;
export type SubmitOrderInput = z.infer<typeof submitOrderSchema>;

/**
 * The same order, with numeric fields widened to bigint for chain calls and hashing.
 *
 * Extends `Record<string, unknown>` so it satisfies viem's EIP-712 `message` parameter, which is
 * typed as an open record. The named fields stay fully typed; this only adds the index signature.
 */
export interface OrderStruct extends Record<string, unknown> {
  maker: `0x${string}`;
  collection: `0x${string}`;
  tokenId: bigint;
  amount: bigint;
  currency: `0x${string}`;
  price: bigint;
  startTime: bigint;
  endTime: bigint;
  salt: bigint;
  nonce: bigint;
  side: number;
  tokenType: number;
}

export function toOrderStruct(order: OrderInput): OrderStruct {
  return {
    maker: order.maker,
    collection: order.collection,
    tokenId: BigInt(order.tokenId),
    amount: BigInt(order.amount),
    currency: order.currency,
    price: BigInt(order.price),
    startTime: BigInt(order.startTime),
    endTime: BigInt(order.endTime),
    salt: BigInt(order.salt),
    nonce: BigInt(order.nonce),
    side: order.side,
    tokenType: order.tokenType,
  };
}

/**
 * Price for a single unit, rounded up.
 *
 * Mirrors the contract's `_proRataPrice` rounding so a floor price shown in the UI can never be
 * lower than what a buyer will actually be charged.
 */
export function unitPrice(price: bigint, amount: bigint): bigint {
  if (amount === 0n) return 0n;
  return (price + amount - 1n) / amount;
}
