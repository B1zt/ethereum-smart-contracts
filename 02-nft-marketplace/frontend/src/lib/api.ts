const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

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

/* ---------------------------------------------------------------- types --- */

export interface ApiOrder {
  hash: string;
  maker: string;
  collection: string;
  tokenId: string;
  amount: string;
  currency: string;
  price: string;
  unitPrice: string;
  startTime: string;
  endTime: string;
  salt: string;
  nonce: string;
  side: 'LISTING' | 'OFFER';
  tokenStandard: 'ERC721' | 'ERC1155';
  signature: string;
  status: 'OPEN' | 'FILLED' | 'CANCELLED' | 'EXPIRED' | 'INVALID';
  filledAmount: string;
}

export interface ApiPhase {
  phaseId: number;
  merkleRoot: string;
  price: string;
  startTime: number;
  endTime: number;
  maxPerWallet: number;
  maxSupply: number;
  isPublic: boolean;
}

export interface ApiTokenMetadata {
  collection: string;
  tokenId: string;
  name: string | null;
  description: string | null;
  imageUrl: string | null;
  thumbnailUrl: string | null;
  attributes: {trait_type: string; value: string}[] | null;
}

export interface ApiAuction {
  id: string;
  seller: string;
  collection: string;
  tokenId: string;
  amount: string;
  currency: string;
  reservePrice: string;
  highestBid: string | null;
  highestBidder: string | null;
  startTime: string;
  endTime: string;
  status: 'ACTIVE' | 'SETTLED' | 'CANCELLED';
  minimumBid?: string | null;
  isSettleable?: boolean;
  secondsRemaining?: number;
  bids?: ApiBid[];
}

export interface ApiBid {
  id: string;
  bidder: string;
  amount: string;
  blockTime: string;
  txHash: string;
}

export interface ApiFill {
  id: string;
  maker: string;
  taker: string;
  tokenId: string;
  price: string;
  currency: string;
  side: 'LISTING' | 'OFFER';
  blockTime: string;
  txHash: string;
}

export interface ApiProof {
  address: string;
  allowance: number;
  proof: `0x${string}`[];
  root: string;
}

/* ----------------------------------------------------------------- api --- */

export const api = {
  config: () =>
    request<{chainId: number; marketplace: string; auction: string; collection: string}>('/config'),

  submitOrder: (order: unknown, signature: string) =>
    request<{order: ApiOrder}>('/orders', {
      method: 'POST',
      body: JSON.stringify({order, signature}),
    }),

  orders: (params: Record<string, string | number | undefined>) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) query.set(key, String(value));
    }
    return request<{orders: ApiOrder[]; nextCursor: string | null}>(`/orders?${query}`);
  },

  collection: (address: string) =>
    request<{
      collection: {
        address: string;
        name: string | null;
        symbol: string | null;
        floorPrice: string | null;
        volumeAllTime: string;
        volume24h: string;
        ownerCount: number;
        totalMinted: string;
        maxSupply: string;
        revealed: boolean;
      };
    }>(`/collections/${address}`),

  phases: (address: string) => request<{phases: ApiPhase[]}>(`/collections/${address}/phases`),

  walletMinted: (address: string, phaseId: number, wallet: string) =>
    request<{minted: string}>(`/collections/${address}/phases/${phaseId}/minted/${wallet}`),

  tokens: (address: string, params: {traits?: string[]; cursor?: string; limit?: number} = {}) => {
    const query = new URLSearchParams();
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.limit) query.set('limit', String(params.limit));
    // Repeated `trait` params, matching the backend's OR-within-type, AND-across-types semantics.
    for (const trait of params.traits ?? []) query.append('trait', trait);

    return request<{
      tokens: (ApiTokenMetadata & {id: string; listing: ApiOrder | null})[];
      nextCursor: string | null;
    }>(`/collections/${address}/tokens?${query}`);
  },

  token: (address: string, tokenId: string) =>
    request<{
      token: {
        collection: string;
        tokenId: string;
        metadata: ApiTokenMetadata | null;
        owners: {owner: string; balance: string}[];
        listings: ApiOrder[];
        offers: ApiOrder[];
        history: ApiFill[];
      };
    }>(`/collections/${address}/tokens/${tokenId}`),

  activity: (address: string, params: {tokenId?: string; limit?: number} = {}) => {
    const query = new URLSearchParams();
    if (params.tokenId) query.set('tokenId', params.tokenId);
    if (params.limit) query.set('limit', String(params.limit));

    return request<{activity: ApiFill[]; nextCursor: string | null}>(
      `/collections/${address}/activity?${query}`,
    );
  },

  portfolio: (wallet: string) =>
    request<{
      wallet: string;
      holdings: {collection: string; tokenId: string; metadata: ApiTokenMetadata | null}[];
      listings: ApiOrder[];
      offers: ApiOrder[];
      auctions: ApiAuction[];
    }>(`/portfolio/${wallet}`),

  auctions: (params: {status?: string; endingSoon?: boolean; limit?: number} = {}) => {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.endingSoon) query.set('endingSoon', 'true');
    if (params.limit) query.set('limit', String(params.limit));

    return request<{auctions: ApiAuction[]; nextCursor: string | null}>(`/auctions?${query}`);
  },

  auction: (id: string) => request<{auction: ApiAuction}>(`/auctions/${id}`),

  /**
   * Allowlist proof for a wallet.
   *
   * Returns null on 404 rather than throwing: "not on the allowlist" is a normal state the mint
   * page renders as ineligible, not an error condition.
   */
  proof: async (collection: string, phaseId: number, address: string): Promise<ApiProof | null> => {
    try {
      return await request<ApiProof>(`/allowlists/${collection}/${phaseId}/proof/${address}`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
