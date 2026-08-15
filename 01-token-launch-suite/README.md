# Token Launch and Distribution Suite

Everything a project needs to launch a token and then be governed by its holders: a capped
governance token, a gas-efficient Merkle airdrop, team vesting with cliffs, an ERC-4626 staking
vault, and a Governor over a timelock.

Contracts in Solidity with Foundry. Backend in TypeScript with Fastify, Prisma and viem. Frontend in
Next.js with wagmi and RainbowKit.

---

## What is actually interesting here

**The airdrop uses a claim bitmap.** A `mapping(address => bool)` costs a fresh 20,000 gas storage
slot per claimant, forever. Packing 256 claims into one word means the first claimant in a word pays
for the slot and the next 255 pay 5,000 gas. Across a 10,000 address airdrop that is roughly 150M
gas saved, paid by users rather than by the project.

**Vesting revocation cannot confiscate earned tokens.** Revoking releases everything already vested
to the beneficiary first, in the same transaction, and only then returns the unvested remainder to
the owner. Skipping that first step would let an owner time a revocation to take back tokens the
beneficiary had already earned. `testFuzz_revocationConservesValue` asserts that beneficiary plus
owner always ends up with exactly the grant, whenever the revocation lands.

**The staking vault defends against the ERC-4626 inflation attack.** The classic exploit: mint 1 wei
of shares, donate a large amount directly, and the next depositor's shares round to zero.
`_decimalsOffset` is raised to 6 on top of OpenZeppelin's virtual-shares defence, and
`test_inflationAttackFails` runs the full attack and asserts the victim keeps their deposit while
the attacker loses their donation.

**Rewards stream rather than land.** A lump-sum reward lets someone deposit in the same block it
arrives, capture a share of it, and leave, diluting everyone who was actually staked. Rewards are
released linearly and excluded from `totalAssets` until they have. `test_lateDepositorDoesNotSteal
EarlierRewards` pins this.

**Voting power is snapshotted, so flash-loan governance does not work.** A proposal counts the
balance you held when voting opened, not the balance you borrowed to vote with.
`test_votingPowerIsSnapshotted` buys a 20M position mid-vote and asserts it counts for nothing.

**The deploy script renounces its own privileges.** This is the step most deployments skip, and
skipping it leaves an EOA able to mint, revoke vesting and drain the vault regardless of how well
governed the system looks. The script prints an ownership check that must read `false, false, true`,
and the handover is verified on a live chain, not only in tests.

**Governance measures time in seconds, not blocks.** Block times are not constant, so a voting
period measured in blocks silently changes length whenever block production does. The token
implements ERC-6372 with `mode=timestamp`, so "seven days to vote" keeps meaning seven days.

---

## Layout

```
contracts/
  src/
    ProjectToken.sol        ERC-20 + Permit + Votes, capped, role-gated mint, one-way finishMinting
    MerkleDistributor.sol   Bitmap-packed airdrop claims with a published deadline
    TokenVesting.sol        Linear vesting with cliff, revocable, funded up front
    StakingVault.sol        ERC-4626 vault with streamed rewards and optional cooldown
    ProjectGovernor.sol     Governor over TimelockController, timestamp clock, fractional quorum
  test/                     85 tests: unit, fuzz, invariants, inflation attack
  script/Deploy.s.sol       Deploys, wires and hands control to the timelock

backend/            Order-free: indexes claims, vesting schedules, stake positions and proposals
frontend/           Claim, vesting dashboard, stake/unstake, governance UI
```

---

## Running it

```bash
docker compose up -d                         # Postgres + Anvil

cd contracts
forge install
forge test                                   # 85 tests
forge lint src                               # clean

PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  forge script script/Deploy.s.sol:Deploy --rpc-url http://127.0.0.1:8545 --broadcast
# Prints the backend env block and an ownership check. The three deployer lines
# must read false, false, true.

cd ../backend  && cp .env.example .env && pnpm install && pnpm db:migrate && pnpm dev
cd ../frontend && cp .env.example .env.local && pnpm install && pnpm dev
```

---

## Tests

```bash
forge test                        # 85 tests
forge test --gas-report
forge coverage --ir-minimum
FOUNDRY_PROFILE=deep forge test   # 10,000 fuzz runs
```

Fuzz properties worth calling out:

- `testFuzz_capIsNeverExceeded` - no sequence of mints exceeds the cap
- `testFuzz_vestedIsMonotonicAndBounded` - vesting never decreases and never exceeds the grant
- `testFuzz_partialClaimsSumToGrant` - however a claim is split in time, the beneficiary receives exactly the grant
- `testFuzz_revocationConservesValue` - beneficiary plus owner always equals the grant
- `testFuzz_vaultIsAlwaysSolvent` - shares outstanding are always redeemable from assets held
- `testFuzz_roundTripNeverProfits` - deposit then immediately withdraw can never return more than went in
- `testFuzz_everyClaimantCanClaimOnce` - every airdrop index claims exactly once, in any order

---

## Security notes

| Decision | Reason |
|---|---|
| Supply cap is `immutable` | An adjustable cap is not a cap. This is the most common rug vector |
| `finishMinting` is one-way | Stronger than revoking a role, which can simply be granted again |
| Minting is role-gated, not owner-gated | The role can go to an emissions contract without handing over every other admin power |
| Vesting is funded at creation | A schedule the contract cannot pay out is a promise, not a commitment |
| Revocation releases vested first | Otherwise an owner can time a revocation to confiscate earned tokens |
| `totalCommitted` bounds the sweep | The owner can never sweep tokens a beneficiary is still owed |
| Airdrop leaves bind the account | A proof cannot be redirected by whoever submits the transaction |
| Airdrop leaves are double hashed | Stops a 64-byte internal node being replayed as a leaf |
| `sweepOther` excludes the airdrop token | Otherwise it is a back door around the claim deadline |
| Reward stream excluded from `totalAssets` | Stops a same-block depositor capturing rewards they did not earn |
| `_decimalsOffset` of 6 | Makes the ERC-4626 inflation attack cost far more than it can return |
| Withdrawal cooldown is capped at 30 days | An owner must not be able to lock stakers in indefinitely |
| Timelock owns everything | The delay is the only real protection a dissenting holder has |
| Deployer renounces all roles | Verified on-chain by the deploy script's ownership check |

One documented trade-off: the cap is checked against `totalSupply`, so burning tokens reopens
mintable headroom. The cap bounds circulating supply, not cumulative issuance.
`test_burn_doesNotIncreaseMintableHeadroom` asserts this behaviour explicitly rather than leaving it
as a surprise.

This code has not been audited. It is a reference implementation.

---

## License

MIT
