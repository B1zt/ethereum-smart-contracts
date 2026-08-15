const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4001/api/v1';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {'Content-Type': 'application/json', ...init?.headers},
  });

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as {error: unknown}).error)
        : `Request failed with ${response.status}`;
    throw new ApiError(message, response.status, body);
  }

  return body as T;
}

export interface TokenInfo {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
  cap: string;
  remainingMintable: string;
  mintingFinished: boolean;
}

export interface ClaimData {
  index: number;
  address: string;
  amount: string;
  proof: `0x${string}`[];
  root: string;
  claimed: boolean;
  claimedAt: string | null;
  deadline: number;
  expired: boolean;
}

export interface AirdropStats {
  entryCount: number;
  claimedCount: number;
  totalAllocated: string;
  totalClaimed: string;
  onChainClaimCount: number;
  rootMatchesChain: boolean | null;
}

export interface VestingSchedule {
  id: string;
  beneficiary: string;
  total: string;
  released: string;
  releasable: string;
  startTime: string;
  cliffSeconds: number;
  durationSeconds: number;
  revocable: boolean;
  revoked: boolean;
  releases: {id: string; amount: string; blockTime: string; txHash: string}[];
}

export interface StakingStats {
  totalAssets: string;
  totalShares: string;
  pricePerShare: string;
  aprBps: number;
  lockedRewards: string;
  stakerCount: number;
}

export interface StakePosition {
  address: string;
  shares: string;
  assets: string;
  netDeposited: string;
  unrealisedGain: string;
  cooldownRemaining: number;
  history: {id: string; kind: string; assets: string; shares: string; blockTime: string}[];
}

export type ProposalState =
  | 'PENDING'
  | 'ACTIVE'
  | 'CANCELED'
  | 'DEFEATED'
  | 'SUCCEEDED'
  | 'QUEUED'
  | 'EXPIRED'
  | 'EXECUTED';

export interface Proposal {
  id: string;
  proposer: string;
  description: string;
  targets: string[];
  values: string[];
  calldatas: string[];
  voteStart: string;
  voteEnd: string;
  state: ProposalState;
  forVotes: string;
  againstVotes: string;
  abstainVotes: string;
  etaAt: string | null;
  executedAt: string | null;
  quorum?: string | null;
  quorumReached?: boolean | null;
  votes?: {
    id: string;
    voter: string;
    support: 'AGAINST' | 'FOR' | 'ABSTAIN';
    weight: string;
    reason: string | null;
    blockTime: string;
  }[];
}

export interface VotingPower {
  address: string;
  balance: string;
  votes: string;
  delegatedTo: string | null;
  hasDelegated: boolean;
  canPropose: boolean;
  proposalThreshold: string;
}

export const api = {
  token: () => request<TokenInfo>('/token'),

  /** Returns null when the wallet has no allocation, which the UI shows as ineligible. */
  claim: async (address: string): Promise<ClaimData | null> => {
    try {
      return await request<ClaimData>(`/airdrop/claim/${address}`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },

  airdropStats: () => request<AirdropStats>('/airdrop/stats'),

  vesting: (address: string) =>
    request<{beneficiary: string; schedules: VestingSchedule[]; totalReleasable: string}>(
      `/vesting/${address}`,
    ),

  vestingCurve: (scheduleId: string) =>
    request<{scheduleId: string; total: string; points: {timestamp: number; vested: string}[]}>(
      `/vesting/${scheduleId}/curve`,
    ),

  stakingStats: () => request<StakingStats>('/staking/stats'),

  stakePosition: (address: string) => request<StakePosition>(`/staking/${address}`),

  stakingHistory: () =>
    request<{snapshots: {pricePerShare: string; aprBps: number; capturedAt: string}[]}>(
      '/staking/history',
    ),

  proposals: (state?: ProposalState) =>
    request<{proposals: Proposal[]; nextCursor: string | null}>(
      `/proposals${state ? `?state=${state}` : ''}`,
    ),

  proposal: (id: string) => request<{proposal: Proposal}>(`/proposals/${id}`),

  votingPower: (address: string) => request<VotingPower>(`/voting-power/${address}`),
};
