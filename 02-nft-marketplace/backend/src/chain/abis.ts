/**
 * Hand-maintained ABI fragments.
 *
 * Only the events and functions the backend actually uses are listed. Importing the full Foundry
 * artifacts would work, but it couples the service build to the contract build and drags several
 * hundred kilobytes of unused JSON into the bundle. `as const` keeps viem's type inference exact,
 * so event args and function returns are fully typed downstream.
 */

export const marketplaceAbi = [
  {
    type: 'event',
    name: 'OrderFilled',
    inputs: [
      {name: 'orderHash', type: 'bytes32', indexed: true},
      {name: 'maker', type: 'address', indexed: true},
      {name: 'taker', type: 'address', indexed: true},
      {name: 'collection', type: 'address', indexed: false},
      {name: 'tokenId', type: 'uint256', indexed: false},
      {name: 'amount', type: 'uint256', indexed: false},
      {name: 'currency', type: 'address', indexed: false},
      {name: 'price', type: 'uint256', indexed: false},
      {name: 'side', type: 'uint8', indexed: false},
    ],
  },
  {
    type: 'event',
    name: 'OrderCancelled',
    inputs: [
      {name: 'orderHash', type: 'bytes32', indexed: true},
      {name: 'maker', type: 'address', indexed: true},
    ],
  },
  {
    type: 'event',
    name: 'NonceIncremented',
    inputs: [
      {name: 'maker', type: 'address', indexed: true},
      {name: 'newNonce', type: 'uint256', indexed: false},
    ],
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
    name: 'filled',
    stateMutability: 'view',
    inputs: [{name: 'orderHash', type: 'bytes32'}],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'cancelled',
    stateMutability: 'view',
    inputs: [{name: 'orderHash', type: 'bytes32'}],
    outputs: [{type: 'bool'}],
  },
  {
    type: 'function',
    name: 'allowedCurrency',
    stateMutability: 'view',
    inputs: [{name: 'currency', type: 'address'}],
    outputs: [{type: 'bool'}],
  },
  {
    type: 'function',
    name: 'protocolFeeBps',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint96'}],
  },
  {
    type: 'function',
    name: 'domainSeparator',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'bytes32'}],
  },
] as const;

export const auctionAbi = [
  {
    type: 'event',
    name: 'AuctionCreated',
    inputs: [
      {name: 'auctionId', type: 'uint256', indexed: true},
      {name: 'seller', type: 'address', indexed: true},
      {name: 'collection', type: 'address', indexed: true},
      {
        name: 'auction',
        type: 'tuple',
        indexed: false,
        components: [
          {name: 'seller', type: 'address'},
          {name: 'collection', type: 'address'},
          {name: 'tokenId', type: 'uint256'},
          {name: 'amount', type: 'uint256'},
          {name: 'currency', type: 'address'},
          {name: 'reservePrice', type: 'uint256'},
          {name: 'highestBid', type: 'uint256'},
          {name: 'highestBidder', type: 'address'},
          {name: 'startTime', type: 'uint64'},
          {name: 'endTime', type: 'uint64'},
          {name: 'extensionWindow', type: 'uint32'},
          {name: 'extensionDuration', type: 'uint32'},
          {name: 'minBidIncrementBps', type: 'uint16'},
          {name: 'tokenType', type: 'uint8'},
          {name: 'settled', type: 'bool'},
        ],
      },
    ],
  },
  {
    type: 'event',
    name: 'BidPlaced',
    inputs: [
      {name: 'auctionId', type: 'uint256', indexed: true},
      {name: 'bidder', type: 'address', indexed: true},
      {name: 'amount', type: 'uint256', indexed: false},
      {name: 'newEndTime', type: 'uint64', indexed: false},
    ],
  },
  {
    type: 'event',
    name: 'AuctionExtended',
    inputs: [
      {name: 'auctionId', type: 'uint256', indexed: true},
      {name: 'newEndTime', type: 'uint64', indexed: false},
    ],
  },
  {
    type: 'event',
    name: 'AuctionSettled',
    inputs: [
      {name: 'auctionId', type: 'uint256', indexed: true},
      {name: 'winner', type: 'address', indexed: true},
      {name: 'amount', type: 'uint256', indexed: false},
    ],
  },
  {
    type: 'event',
    name: 'AuctionCancelled',
    inputs: [{name: 'auctionId', type: 'uint256', indexed: true}],
  },
  {
    type: 'function',
    name: 'minimumBid',
    stateMutability: 'view',
    inputs: [{name: 'auctionId', type: 'uint256'}],
    outputs: [{type: 'uint256'}],
  },
] as const;

export const collectionAbi = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      {name: 'from', type: 'address', indexed: true},
      {name: 'to', type: 'address', indexed: true},
      {name: 'tokenId', type: 'uint256', indexed: true},
    ],
  },
  {
    type: 'event',
    name: 'Minted',
    inputs: [
      {name: 'to', type: 'address', indexed: true},
      {name: 'phaseId', type: 'uint256', indexed: true},
      {name: 'quantity', type: 'uint256', indexed: false},
      {name: 'startTokenId', type: 'uint256', indexed: false},
      {name: 'paid', type: 'uint256', indexed: false},
    ],
  },
  {
    type: 'event',
    name: 'Revealed',
    inputs: [{name: 'baseURI', type: 'string', indexed: false}],
  },
  {
    type: 'function',
    name: 'name',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'string'}],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'string'}],
  },
  {
    type: 'function',
    name: 'tokenURI',
    stateMutability: 'view',
    inputs: [{name: 'tokenId', type: 'uint256'}],
    outputs: [{type: 'string'}],
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
    name: 'revealed',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'bool'}],
  },
  {
    type: 'function',
    name: 'phaseCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'phases',
    stateMutability: 'view',
    inputs: [{name: 'phaseId', type: 'uint256'}],
    outputs: [
      {
        type: 'tuple',
        components: [
          {name: 'merkleRoot', type: 'bytes32'},
          {name: 'price', type: 'uint96'},
          {name: 'startTime', type: 'uint64'},
          {name: 'endTime', type: 'uint64'},
          {name: 'maxPerWallet', type: 'uint16'},
          {name: 'maxSupply', type: 'uint16'},
        ],
      },
    ],
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
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{name: 'tokenId', type: 'uint256'}],
    outputs: [{type: 'address'}],
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
    name: 'getApproved',
    stateMutability: 'view',
    inputs: [{name: 'tokenId', type: 'uint256'}],
    outputs: [{type: 'address'}],
  },
] as const;

export const erc1155Abi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [
      {name: 'account', type: 'address'},
      {name: 'id', type: 'uint256'},
    ],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'isApprovedForAll',
    stateMutability: 'view',
    inputs: [
      {name: 'account', type: 'address'},
      {name: 'operator', type: 'address'},
    ],
    outputs: [{type: 'bool'}],
  },
] as const;

export const erc20Abi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{name: 'account', type: 'address'}],
    outputs: [{type: 'uint256'}],
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
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint8'}],
  },
] as const;
