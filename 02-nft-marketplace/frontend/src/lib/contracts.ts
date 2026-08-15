import type {Address} from 'viem';

/**
 * Contract addresses.
 *
 * Read from build-time env so a single frontend build can be pointed at Sepolia, a local Anvil node
 * or mainnet without a code change.
 */
export const contracts = {
  marketplace: (process.env.NEXT_PUBLIC_MARKETPLACE_ADDRESS ??
    '0x0000000000000000000000000000000000000000') as Address,
  auction: (process.env.NEXT_PUBLIC_AUCTION_ADDRESS ??
    '0x0000000000000000000000000000000000000000') as Address,
  collection: (process.env.NEXT_PUBLIC_COLLECTION_ADDRESS ??
    '0x0000000000000000000000000000000000000000') as Address,
  weth: (process.env.NEXT_PUBLIC_WETH_ADDRESS ??
    '0x0000000000000000000000000000000000000000') as Address,
} as const;

export const orderStructAbi = {
  type: 'tuple',
  components: [
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

export const marketplaceAbi = [
  {
    type: 'function',
    name: 'fulfillListing',
    stateMutability: 'payable',
    inputs: [
      {...orderStructAbi, name: 'order'},
      {name: 'signature', type: 'bytes'},
      {name: 'amountToFill', type: 'uint256'},
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'acceptOffer',
    stateMutability: 'nonpayable',
    inputs: [
      {...orderStructAbi, name: 'order'},
      {name: 'signature', type: 'bytes'},
      {name: 'amountToFill', type: 'uint256'},
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'cancelOrder',
    stateMutability: 'nonpayable',
    inputs: [{...orderStructAbi, name: 'order'}],
    outputs: [],
  },
  {
    type: 'function',
    name: 'incrementNonce',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'nonces',
    stateMutability: 'view',
    inputs: [{name: 'maker', type: 'address'}],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'escrowedBalance',
    stateMutability: 'view',
    inputs: [{name: 'recipient', type: 'address'}],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'withdrawEscrow',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'protocolFeeBps',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint96'}],
  },
] as const;

export const collectionAbi = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'payable',
    inputs: [
      {name: 'phaseId', type: 'uint256'},
      {name: 'quantity', type: 'uint256'},
      {name: 'allowance', type: 'uint256'},
      {name: 'proof', type: 'bytes32[]'},
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setApprovalForAll',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'operator', type: 'address'},
      {name: 'approved', type: 'bool'},
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'isApprovedForAll',
    stateMutability: 'view',
    inputs: [
      {name: 'owner', type: 'address'},
      {name: 'operator', type: 'address'},
    ],
    outputs: [{type: 'bool'}],
  },
  {
    type: 'function',
    name: 'totalMinted',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'maxSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'walletMinted',
    stateMutability: 'view',
    inputs: [
      {name: 'phaseId', type: 'uint256'},
      {name: 'wallet', type: 'address'},
    ],
    outputs: [{type: 'uint256'}],
  },
] as const;

export const auctionAbi = [
  {
    type: 'function',
    name: 'bid',
    stateMutability: 'payable',
    inputs: [
      {name: 'auctionId', type: 'uint256'},
      {name: 'bidAmount', type: 'uint256'},
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'settle',
    stateMutability: 'nonpayable',
    inputs: [{name: 'auctionId', type: 'uint256'}],
    outputs: [],
  },
  {
    type: 'function',
    name: 'cancelAuction',
    stateMutability: 'nonpayable',
    inputs: [{name: 'auctionId', type: 'uint256'}],
    outputs: [],
  },
  {
    type: 'function',
    name: 'createAuction',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'collection', type: 'address'},
      {name: 'tokenId', type: 'uint256'},
      {name: 'amount', type: 'uint256'},
      {name: 'tokenType', type: 'uint8'},
      {name: 'currency', type: 'address'},
      {name: 'reservePrice', type: 'uint256'},
      {name: 'startTime', type: 'uint64'},
      {name: 'endTime', type: 'uint64'},
      {name: 'extensionWindow', type: 'uint32'},
      {name: 'extensionDuration', type: 'uint32'},
      {name: 'minBidIncrementBps', type: 'uint16'},
    ],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'minimumBid',
    stateMutability: 'view',
    inputs: [{name: 'auctionId', type: 'uint256'}],
    outputs: [{type: 'uint256'}],
  },
] as const;

export const erc20Abi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'spender', type: 'address'},
      {name: 'amount', type: 'uint256'},
    ],
    outputs: [{type: 'bool'}],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      {name: 'owner', type: 'address'},
      {name: 'spender', type: 'address'},
    ],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{name: 'account', type: 'address'}],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
  },
] as const;
