import type {Address} from 'viem';

/**
 * EIP-712 order signing, client side.
 *
 * The type definition here, the one in the backend, and `OrderTypes.ORDER_TYPEHASH` in the contract
 * are three copies of the same thing and must stay identical. If any one drifts, signatures recover
 * to the wrong address and fills revert with `InvalidSignature`, which is a miserable bug to chase
 * because nothing about the failure points at the type definition.
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

export const Side = {Listing: 0, Offer: 1} as const;
export const TokenType = {ERC721: 0, ERC1155: 1} as const;

export const NATIVE_CURRENCY = '0x0000000000000000000000000000000000000000' as const;

export interface Order {
  maker: Address;
  collection: Address;
  tokenId: bigint;
  amount: bigint;
  currency: Address;
  price: bigint;
  startTime: bigint;
  endTime: bigint;
  salt: bigint;
  nonce: bigint;
  side: number;
  tokenType: number;
}

export function buildDomain(chainId: number, marketplace: Address) {
  return {
    name: 'B1zt Marketplace',
    version: '1',
    chainId,
    verifyingContract: marketplace,
  } as const;
}

/**
 * Random salt so two otherwise identical orders hash differently.
 *
 * `crypto.getRandomValues` rather than `Math.random`: a predictable salt lets someone else compute
 * a maker's future order hashes before they are published, which is not exploitable on its own but
 * is free to avoid.
 */
export function randomSalt(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);

  let salt = 0n;
  for (const byte of bytes) {
    salt = (salt << 8n) | BigInt(byte);
  }

  return salt;
}

/** JSON-safe order, matching what `POST /orders` expects. */
export function serializeOrder(order: Order) {
  return {
    maker: order.maker,
    collection: order.collection,
    tokenId: order.tokenId.toString(),
    amount: order.amount.toString(),
    currency: order.currency,
    price: order.price.toString(),
    startTime: order.startTime.toString(),
    endTime: order.endTime.toString(),
    salt: order.salt.toString(),
    nonce: order.nonce.toString(),
    side: order.side,
    tokenType: order.tokenType,
  };
}

export function deserializeOrder(raw: Record<string, string | number>): Order {
  return {
    maker: raw.maker as Address,
    collection: raw.collection as Address,
    tokenId: BigInt(raw.tokenId as string),
    amount: BigInt(raw.amount as string),
    currency: raw.currency as Address,
    price: BigInt(raw.price as string),
    startTime: BigInt(Math.floor(new Date(raw.startTime as string).getTime() / 1000)),
    endTime: BigInt(Math.floor(new Date(raw.endTime as string).getTime() / 1000)),
    salt: BigInt(raw.salt as string),
    nonce: BigInt(raw.nonce as string),
    side: raw.side === 'LISTING' ? Side.Listing : Side.Offer,
    tokenType: raw.tokenStandard === 'ERC721' ? TokenType.ERC721 : TokenType.ERC1155,
  };
}

export interface BuildListingParams {
  maker: Address;
  collection: Address;
  tokenId: bigint;
  priceWei: bigint;
  /** Seconds from now until the listing expires. */
  durationSeconds: number;
  nonce: bigint;
  currency?: Address;
  amount?: bigint;
  tokenType?: number;
}

export function buildListing(params: BuildListingParams): Order {
  const now = BigInt(Math.floor(Date.now() / 1000));

  return {
    maker: params.maker,
    collection: params.collection,
    tokenId: params.tokenId,
    amount: params.amount ?? 1n,
    currency: params.currency ?? NATIVE_CURRENCY,
    price: params.priceWei,
    // Backdated by a minute. Wallets and nodes disagree about "now" by a few seconds, and a start
    // time in the future makes the very first fill attempt revert with `OrderNotStarted`.
    startTime: now - 60n,
    endTime: now + BigInt(params.durationSeconds),
    salt: randomSalt(),
    nonce: params.nonce,
    side: Side.Listing,
    tokenType: params.tokenType ?? TokenType.ERC721,
  };
}

export interface BuildOfferParams extends Omit<BuildListingParams, 'currency'> {
  /** Offers cannot use native ETH, so a WETH-style token address is required. */
  currency: Address;
}

export function buildOffer(params: BuildOfferParams): Order {
  const now = BigInt(Math.floor(Date.now() / 1000));

  return {
    maker: params.maker,
    collection: params.collection,
    tokenId: params.tokenId,
    amount: params.amount ?? 1n,
    currency: params.currency,
    price: params.priceWei,
    startTime: now - 60n,
    endTime: now + BigInt(params.durationSeconds),
    salt: randomSalt(),
    nonce: params.nonce,
    side: Side.Offer,
    tokenType: params.tokenType ?? TokenType.ERC721,
  };
}

/** Human-readable reasons for the rejection codes the API returns. */
export const REJECTION_MESSAGES: Record<string, string> = {
  INVALID_SIGNATURE: 'Signature did not verify. Try signing again.',
  EXPIRED: 'This order has already expired.',
  BAD_WINDOW: 'The order window is invalid.',
  STALE_NONCE: 'You cancelled all orders after signing this one. Sign a new order.',
  CANCELLED_ON_CHAIN: 'This order was cancelled on-chain.',
  ALREADY_FILLED: 'This order has already been filled.',
  NOT_OWNER: 'You no longer own this token.',
  NOT_APPROVED: 'The marketplace is not approved to transfer this token.',
  INSUFFICIENT_BALANCE: 'Not enough balance to cover this order.',
  INSUFFICIENT_ALLOWANCE: 'Token spending allowance is too low.',
  CURRENCY_NOT_ALLOWED: 'That payment token is not accepted.',
  NATIVE_OFFER: 'Offers must use WETH, not native ETH.',
  BAD_AMOUNT: 'Invalid quantity for this token standard.',
};
