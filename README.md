# Ethereum Smart Contracts

Two full-stack Ethereum projects, each with contracts, a backend that indexes the chain, and a
frontend. Both run end to end on a laptop with no testnet faucet and no API keys.

Solidity 0.8.28 with Foundry. TypeScript with Fastify, Prisma and viem. Next.js with wagmi and
RainbowKit.

---

## [01 - Token Launch Suite](01-token-launch-suite)

Everything a project needs on launch day: a capped token, a Merkle airdrop, team vesting with
cliffs, an ERC-4626 staking vault and governance behind a timelock.

[![Token launch suite](01-token-launch-suite/docs/screenshots/01-overview.png)](01-token-launch-suite)

Every privileged role ends up held by the timelock, and the deploy script verifies on-chain that the
deployer kept nothing. 88 tests including fuzz and invariant runs.

---

## [02 - NFT Collection and Marketplace](02-nft-marketplace)

A collection with phased Merkle allowlist minting, a gasless EIP-712 order book, and English
auctions that extend on late bids.

[![NFT marketplace](02-nft-marketplace/docs/screenshots/02-explore.png)](02-nft-marketplace)

Listing costs no gas, cancelling every order you ever signed costs one transaction, and the indexer
is built so a chain reorg cannot leave a phantom sale behind. 130 tests.

---

## Running either one

Each project has its own README with a step-by-step setup. The shape is the same:

```bash
cd 01-token-launch-suite        # or 02-nft-marketplace
docker compose up -d            # Postgres and a local Anvil chain
cd contracts && forge script script/Deploy.s.sol:Deploy --rpc-url $RPC --broadcast
cd ../backend && pnpm install && pnpm prisma db push && pnpm db:seed && pnpm dev
cd ../frontend && pnpm install && pnpm dev
```

Both ship a demo script that puts realistic state on the local chain, and a database seed for the
parts an indexer would normally build from months of history. Without them every page renders
correctly and empty, which tells you nothing about whether the app works.

The two projects use different ports, so you can run both at once.

---

None of this has been audited. It is written to be read.

## License

MIT
