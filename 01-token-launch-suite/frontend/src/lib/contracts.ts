import type {Address} from 'viem';

/** Read from build-time env so one build can target Anvil, Sepolia or mainnet unchanged. */
const env = (key: string): Address =>
  (process.env[key] ?? '0x0000000000000000000000000000000000000000') as Address;

export const contracts = {
  token: env('NEXT_PUBLIC_TOKEN_ADDRESS'),
  timelock: env('NEXT_PUBLIC_TIMELOCK_ADDRESS'),
  governor: env('NEXT_PUBLIC_GOVERNOR_ADDRESS'),
  vesting: env('NEXT_PUBLIC_VESTING_ADDRESS'),
  distributor: env('NEXT_PUBLIC_DISTRIBUTOR_ADDRESS'),
  vault: env('NEXT_PUBLIC_VAULT_ADDRESS'),
} as const;

export const tokenAbi = [
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
    name: 'delegate',
    stateMutability: 'nonpayable',
    inputs: [{name: 'delegatee', type: 'address'}],
    outputs: [],
  },
  {
    type: 'function',
    name: 'delegates',
    stateMutability: 'view',
    inputs: [{name: 'account', type: 'address'}],
    outputs: [{type: 'address'}],
  },
  {
    type: 'function',
    name: 'getVotes',
    stateMutability: 'view',
    inputs: [{name: 'account', type: 'address'}],
    outputs: [{type: 'uint256'}],
  },
  {type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{type: 'string'}]},
] as const;

export const distributorAbi = [
  {
    type: 'function',
    name: 'claim',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'index', type: 'uint256'},
      {name: 'account', type: 'address'},
      {name: 'amount', type: 'uint256'},
      {name: 'proof', type: 'bytes32[]'},
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'isClaimed',
    stateMutability: 'view',
    inputs: [{name: 'index', type: 'uint256'}],
    outputs: [{type: 'bool'}],
  },
] as const;

export const vestingAbi = [
  {
    type: 'function',
    name: 'release',
    stateMutability: 'nonpayable',
    inputs: [{name: 'scheduleId', type: 'uint256'}],
    outputs: [],
  },
  {
    type: 'function',
    name: 'releaseMany',
    stateMutability: 'nonpayable',
    inputs: [{name: 'scheduleIds', type: 'uint256[]'}],
    outputs: [],
  },
  {
    type: 'function',
    name: 'releasableAmount',
    stateMutability: 'view',
    inputs: [{name: 'scheduleId', type: 'uint256'}],
    outputs: [{type: 'uint256'}],
  },
] as const;

export const vaultAbi = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'assets', type: 'uint256'},
      {name: 'receiver', type: 'address'},
    ],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'redeem',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'shares', type: 'uint256'},
      {name: 'receiver', type: 'address'},
      {name: 'owner', type: 'address'},
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
    name: 'convertToAssets',
    stateMutability: 'view',
    inputs: [{name: 'shares', type: 'uint256'}],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'previewDeposit',
    stateMutability: 'view',
    inputs: [{name: 'assets', type: 'uint256'}],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'cooldownRemaining',
    stateMutability: 'view',
    inputs: [{name: 'account', type: 'address'}],
    outputs: [{type: 'uint256'}],
  },
] as const;

export const governorAbi = [
  {
    type: 'function',
    name: 'castVote',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'proposalId', type: 'uint256'},
      {name: 'support', type: 'uint8'},
    ],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'castVoteWithReason',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'proposalId', type: 'uint256'},
      {name: 'support', type: 'uint8'},
      {name: 'reason', type: 'string'},
    ],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'queue',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'targets', type: 'address[]'},
      {name: 'values', type: 'uint256[]'},
      {name: 'calldatas', type: 'bytes[]'},
      {name: 'descriptionHash', type: 'bytes32'},
    ],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'payable',
    inputs: [
      {name: 'targets', type: 'address[]'},
      {name: 'values', type: 'uint256[]'},
      {name: 'calldatas', type: 'bytes[]'},
      {name: 'descriptionHash', type: 'bytes32'},
    ],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'hasVoted',
    stateMutability: 'view',
    inputs: [
      {name: 'proposalId', type: 'uint256'},
      {name: 'account', type: 'address'},
    ],
    outputs: [{type: 'bool'}],
  },
] as const;

/** `GovernorCountingSimple` support values, matching the on-chain enum order. */
export const VOTE_SUPPORT = {Against: 0, For: 1, Abstain: 2} as const;
