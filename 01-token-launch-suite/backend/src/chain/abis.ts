/**
 * Hand-maintained ABI fragments.
 *
 * Only what the backend actually reads or indexes. Importing the full Foundry artifacts would work
 * but couples the service build to the contract build. `as const` keeps viem's inference exact, so
 * event args and call returns are fully typed downstream.
 */

export const tokenAbi = [
  {
    type: 'event',
    name: 'DelegateVotesChanged',
    inputs: [
      {name: 'delegate', type: 'address', indexed: true},
      {name: 'previousVotes', type: 'uint256', indexed: false},
      {name: 'newVotes', type: 'uint256', indexed: false},
    ],
  },
  {
    type: 'event',
    name: 'DelegateChanged',
    inputs: [
      {name: 'delegator', type: 'address', indexed: true},
      {name: 'fromDelegate', type: 'address', indexed: true},
      {name: 'toDelegate', type: 'address', indexed: true},
    ],
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
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint256'}],
  },
  {type: 'function', name: 'cap', stateMutability: 'view', inputs: [], outputs: [{type: 'uint256'}]},
  {
    type: 'function',
    name: 'remainingMintable',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'mintingFinished',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'bool'}],
  },
  {
    type: 'function',
    name: 'getVotes',
    stateMutability: 'view',
    inputs: [{name: 'account', type: 'address'}],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'delegates',
    stateMutability: 'view',
    inputs: [{name: 'account', type: 'address'}],
    outputs: [{type: 'address'}],
  },
  {type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{type: 'string'}]},
  {type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{type: 'string'}]},
  {type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{type: 'uint8'}]},
] as const;

export const distributorAbi = [
  {
    type: 'event',
    name: 'Claimed',
    inputs: [
      {name: 'index', type: 'uint256', indexed: true},
      {name: 'account', type: 'address', indexed: true},
      {name: 'amount', type: 'uint256', indexed: false},
    ],
  },
  {
    type: 'function',
    name: 'isClaimed',
    stateMutability: 'view',
    inputs: [{name: 'index', type: 'uint256'}],
    outputs: [{type: 'bool'}],
  },
  {
    type: 'function',
    name: 'merkleRoot',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'bytes32'}],
  },
  {
    type: 'function',
    name: 'claimDeadline',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'totalClaimed',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'claimCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint256'}],
  },
] as const;

export const vestingAbi = [
  {
    type: 'event',
    name: 'ScheduleCreated',
    inputs: [
      {name: 'scheduleId', type: 'uint256', indexed: true},
      {name: 'beneficiary', type: 'address', indexed: true},
      {
        name: 'schedule',
        type: 'tuple',
        indexed: false,
        components: [
          {name: 'beneficiary', type: 'address'},
          {name: 'total', type: 'uint128'},
          {name: 'released', type: 'uint128'},
          {name: 'start', type: 'uint64'},
          {name: 'cliff', type: 'uint64'},
          {name: 'duration', type: 'uint64'},
          {name: 'revocable', type: 'bool'},
          {name: 'revoked', type: 'bool'},
        ],
      },
    ],
  },
  {
    type: 'event',
    name: 'Released',
    inputs: [
      {name: 'scheduleId', type: 'uint256', indexed: true},
      {name: 'beneficiary', type: 'address', indexed: true},
      {name: 'amount', type: 'uint256', indexed: false},
    ],
  },
  {
    type: 'event',
    name: 'Revoked',
    inputs: [
      {name: 'scheduleId', type: 'uint256', indexed: true},
      {name: 'beneficiary', type: 'address', indexed: true},
      {name: 'refunded', type: 'uint256', indexed: false},
    ],
  },
  {
    type: 'function',
    name: 'releasableAmount',
    stateMutability: 'view',
    inputs: [{name: 'scheduleId', type: 'uint256'}],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'vestedAt',
    stateMutability: 'view',
    inputs: [
      {name: 'scheduleId', type: 'uint256'},
      {name: 'timestamp', type: 'uint256'},
    ],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'schedulesOf',
    stateMutability: 'view',
    inputs: [{name: 'beneficiary', type: 'address'}],
    outputs: [{type: 'uint256[]'}],
  },
  {
    type: 'function',
    name: 'totalReleasableOf',
    stateMutability: 'view',
    inputs: [{name: 'beneficiary', type: 'address'}],
    outputs: [{type: 'uint256'}],
  },
] as const;

export const vaultAbi = [
  {
    type: 'event',
    name: 'Deposit',
    inputs: [
      {name: 'sender', type: 'address', indexed: true},
      {name: 'owner', type: 'address', indexed: true},
      {name: 'assets', type: 'uint256', indexed: false},
      {name: 'shares', type: 'uint256', indexed: false},
    ],
  },
  {
    type: 'event',
    name: 'Withdraw',
    inputs: [
      {name: 'sender', type: 'address', indexed: true},
      {name: 'receiver', type: 'address', indexed: true},
      {name: 'owner', type: 'address', indexed: true},
      {name: 'assets', type: 'uint256', indexed: false},
      {name: 'shares', type: 'uint256', indexed: false},
    ],
  },
  {
    type: 'event',
    name: 'RewardsAdded',
    inputs: [
      {name: 'amount', type: 'uint256', indexed: false},
      {name: 'finishAt', type: 'uint256', indexed: false},
    ],
  },
  {
    type: 'function',
    name: 'totalAssets',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'pricePerShare',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'currentApr',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'lockedRewards',
    stateMutability: 'view',
    inputs: [],
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
    name: 'cooldownRemaining',
    stateMutability: 'view',
    inputs: [{name: 'account', type: 'address'}],
    outputs: [{type: 'uint256'}],
  },
] as const;

export const governorAbi = [
  {
    type: 'event',
    name: 'ProposalCreated',
    inputs: [
      {name: 'proposalId', type: 'uint256', indexed: false},
      {name: 'proposer', type: 'address', indexed: false},
      {name: 'targets', type: 'address[]', indexed: false},
      {name: 'values', type: 'uint256[]', indexed: false},
      {name: 'signatures', type: 'string[]', indexed: false},
      {name: 'calldatas', type: 'bytes[]', indexed: false},
      {name: 'voteStart', type: 'uint256', indexed: false},
      {name: 'voteEnd', type: 'uint256', indexed: false},
      {name: 'description', type: 'string', indexed: false},
    ],
  },
  {
    type: 'event',
    name: 'VoteCast',
    inputs: [
      {name: 'voter', type: 'address', indexed: true},
      {name: 'proposalId', type: 'uint256', indexed: false},
      {name: 'support', type: 'uint8', indexed: false},
      {name: 'weight', type: 'uint256', indexed: false},
      {name: 'reason', type: 'string', indexed: false},
    ],
  },
  {
    type: 'event',
    name: 'ProposalQueued',
    inputs: [
      {name: 'proposalId', type: 'uint256', indexed: false},
      {name: 'etaSeconds', type: 'uint256', indexed: false},
    ],
  },
  {
    type: 'event',
    name: 'ProposalExecuted',
    inputs: [{name: 'proposalId', type: 'uint256', indexed: false}],
  },
  {
    type: 'event',
    name: 'ProposalCanceled',
    inputs: [{name: 'proposalId', type: 'uint256', indexed: false}],
  },
  {
    type: 'function',
    name: 'state',
    stateMutability: 'view',
    inputs: [{name: 'proposalId', type: 'uint256'}],
    outputs: [{type: 'uint8'}],
  },
  {
    type: 'function',
    name: 'proposalVotes',
    stateMutability: 'view',
    inputs: [{name: 'proposalId', type: 'uint256'}],
    outputs: [
      {name: 'againstVotes', type: 'uint256'},
      {name: 'forVotes', type: 'uint256'},
      {name: 'abstainVotes', type: 'uint256'},
    ],
  },
  {
    type: 'function',
    name: 'quorum',
    stateMutability: 'view',
    inputs: [{name: 'timepoint', type: 'uint256'}],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'proposalThreshold',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'votingDelay',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'votingPeriod',
    stateMutability: 'view',
    inputs: [],
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

/** OpenZeppelin Governor's `ProposalState` enum, in declaration order. */
export const PROPOSAL_STATES = [
  'PENDING',
  'ACTIVE',
  'CANCELED',
  'DEFEATED',
  'SUCCEEDED',
  'QUEUED',
  'EXPIRED',
  'EXECUTED',
] as const;

/** `GovernorCountingSimple`'s support values. */
export const VOTE_SUPPORT = ['AGAINST', 'FOR', 'ABSTAIN'] as const;
