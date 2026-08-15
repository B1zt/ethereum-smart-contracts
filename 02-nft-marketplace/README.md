# NFT Collection and Marketplace

A full-stack NFT platform on Ethereum: a gas-optimised collection with multi-phase Merkle allowlist
minting, an ERC-1155 edition contract, a gasless EIP-712 order book, and English auctions that
extend on late bids.

Contracts in Solidity with Foundry. Backend in TypeScript with Fastify, Prisma and viem. Frontend in
Next.js with wagmi and RainbowKit.

---

## What is actually interesting here

Most NFT marketplace samples stop at "transfer the token, send the ETH". These are the parts that
take real work to get right, and each one is covered by tests that would fail if it were done the
naive way.

**Listing costs no gas.** Sellers sign an EIP-712 order in their wallet; nothing touches the chain
until a buyer settles it. Cancelling one order is one storage write. Cancelling every order a maker
has ever signed is also one storage write, via a nonce bump.

**Merkle leaves carry per-address allowances.** A leaf commits to `(address, allowance)` rather than
just an address, so one root expresses per-wallet tiers instead of a flat cap. Leaves are double
hashed, which is what stops a 64-byte internal node from being replayed as a leaf to forge
membership.

**The off-chain tree and the on-chain verifier are pinned to each other.** Both build a tree from
the same fixed entry set and assert the same root constant, in
[`MerkleCrossCheck.t.sol`](contracts/test/MerkleCrossCheck.t.sol) and
[`tree.test.ts`](backend/src/merkle/tree.test.ts). Without this, a mismatch in leaf encoding or pair
ordering fails silently: the API serves well-formed proofs and every mint reverts on-chain.

**Hostile collections cannot break settlement.** `royaltyInfo` is a call into an untrusted contract.
It may revert, return nonsense, or claim a 90% royalty and drain the seller. The call is wrapped,
the interface is probed first, and the result is capped at 10%. Tested with a
`GreedyRoyaltyCollection` and a `RevertingRoyaltyCollection`.

**Payouts cannot brick a trade.** A recipient that rejects ETH would otherwise make every sale
involving them permanently unfillable. Failed native pushes become a withdrawable credit instead,
with the forwarded gas capped so a recipient cannot grief settlement by burning it.

**Auctions extend on late bids.** Without this, the winning strategy is to bid in the final block
and the auction is decided by whoever pays the highest priority fee. A bid inside the extension
window pushes the end time out.

**The indexer survives reorgs.** The cursor tracks the highest *final* block, trailing the head by a
confirmation depth. Each pass deletes rows sourced from non-final blocks and re-scans. Every write
is keyed on `(txHash, logIndex)`, so replaying a range is a no-op rather than a double count, and
the process can be killed at any point and resumed without bookkeeping.

---

## Layout

```
contracts/          Foundry project
  src/
    Collection721.sol      ERC-721A collection, phases, allowlists, delayed reveal, EIP-2981
    Editions1155.sol       ERC-1155 multi-edition drops
    Marketplace.sol        EIP-712 order book, partial fills, EIP-1271 contract wallets
    EnglishAuction.sol     Escrowed auctions with anti-snipe extension
    PaymentSettler.sol     Shared fee, royalty and payout logic
    OrderTypes.sol         EIP-712 order struct and type hash
  test/                    130 tests: unit, fuzz, attacker contracts, cross-check
  script/Deploy.s.sol      Deploys the stack and prints both env files

backend/            Fastify + Prisma + viem
  src/orders/              Order validation against live chain state, order book API
  src/indexer/             Reorg-safe log indexer
  src/merkle/              Allowlist tree builder and proof endpoint
  src/collections/         Collection, token, trait filtering, portfolio
  src/auctions/            Auction and bid queries

frontend/           Next.js App Router + wagmi + RainbowKit
  src/app/                 Mint, explore, token detail, auctions, portfolio
  src/components/          MintPanel, TradePanel, TokenCard
  src/hooks/useSignOrder   Sign an EIP-712 order and publish it
  src/lib/orders.ts        Client-side order construction
```

---

## Running it

Everything runs locally against Anvil. No testnet faucet, no RPC key.

```bash
# 1. Postgres and a local chain
docker compose up -d

# 2. Contracts
cd contracts
forge install
forge test                                   # 130 tests

PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  forge script script/Deploy.s.sol:Deploy --rpc-url http://127.0.0.1:8545 --broadcast
# Prints the exact env blocks for the backend and frontend. Paste them in.

# 3. Backend
cd ../backend
cp .env.example .env                         # paste the printed addresses
pnpm install
pnpm db:migrate
pnpm dev                                     # http://localhost:4000

# 4. Frontend
cd ../frontend
cp .env.example .env.local                   # paste the printed addresses
pnpm install
pnpm dev                                     # http://localhost:3000
```

To open minting, add a phase as the owner:

```bash
NOW=$(cast block latest --rpc-url http://127.0.0.1:8545 --field timestamp)

cast send $COLLECTION "addPhase((bytes32,uint96,uint64,uint64,uint16,uint16))" \
  "(0x0,10000000000000000,$NOW,$((NOW + 86400)),5,0)" \
  --private-key $PRIVATE_KEY --rpc-url http://127.0.0.1:8545
```

That is a public phase: no Merkle root, 0.01 ETH, five per wallet, open for a day.

---

## Tests

```bash
cd contracts
forge test                    # 130 tests
forge test --gas-report
forge coverage --ir-minimum
FOUNDRY_PROFILE=deep forge test   # 10,000 fuzz runs

cd ../backend
pnpm test                     # merkle cross-check
```

Coverage sits at 92% of lines. The suite includes fuzz tests for value conservation (fee plus
royalty plus proceeds always equals the price exactly, with nothing stranded in the venue),
invariant tests on supply caps, and dedicated attacker contracts for reentrancy, greedy royalties
and rejected payouts.

---

## Security notes

Deliberate design decisions, and what each one is defending against:

| Decision | Reason |
|---|---|
| Royalties capped at 10% | A malicious collection could otherwise report a 100% royalty and take the seller's proceeds |
| `royaltyInfo` wrapped in `try` | A collection whose royalty call reverts would make its own tokens untradeable |
| Native pushes capped at 30k gas | Stops a recipient griefing settlement by burning all forwarded gas |
| Failed pushes fall back to escrow | A recipient that rejects ETH must not brick every trade it touches |
| Payment must be exact on mint | Silently keeping an overpayment is a quiet way to take user funds |
| Phase edits preserve mint counters | Otherwise the owner grants unlimited extra allocation by touching the config |
| Provenance hash is write-once | The commitment is worthless if it can be rewritten after seeing who minted what |
| Reveal and metadata freeze are one-way | The strongest signal a creator can give that the art will not be swapped |
| Cancellation is never pausable | A pause must not trap a maker in a live order |
| Escrow withdrawal is never pausable | A pause must not trap user funds |
| ERC-20 currencies are allowlisted | Fee-on-transfer and rebasing tokens break the accounting assumption that the recipient receives what was sent |
| Auctions escrow the asset | A signature-based auction lets the seller move the asset mid-auction, so every bid settles into a revert |
| Auctions cannot be cancelled after a bid | Otherwise a seller walks away from any price they do not like |
| Settlement is permissionless | A trade must not be held hostage by an absent seller or winner |

`Ownable2Step` throughout, so a mistyped ownership transfer cannot brick admin access. Every
privileged function is `onlyOwner`, and **the owner should be a multisig in production**. The deploy
script accepts an `OWNER` env var for exactly that.

This code has not been audited. It is a reference implementation.

---

## License

MIT
