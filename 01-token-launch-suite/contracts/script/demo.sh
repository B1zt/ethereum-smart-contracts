#!/usr/bin/env bash
#
# Demo state for a local chain.
#
# Driven with `cast` rather than a Solidity script because two steps need the timelock to act, and
# on a real chain the timelock is only reachable by passing a governance proposal. Anvil can
# impersonate it directly, which is the normal way to set up local state without waiting out a
# voting period.
#
# Run it once against a fresh chain, after Deploy.s.sol. The addresses below are what Deploy prints
# on a chain with no prior history; override them if yours differ.
#
# Local chains only: every key here comes from the public Anvil mnemonic.
set -euo pipefail

RPC=${RPC:-http://localhost:8545}
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

ALICE=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
ALICE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
BOB=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
BOB_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
CAROL=0x90F79bf6EB2c4f870365E785982E1f101E93b906
CAROL_KEY=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6

TOKEN=${TOKEN_ADDRESS:-0x5FbDB2315678afecb367f032d93F642f64180aa3}
TIMELOCK=${TIMELOCK_ADDRESS:-0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512}
VESTING=${VESTING_ADDRESS:-0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9}
VAULT=${VAULT_ADDRESS:-0x5FC8d32690cc91D4c39d9d3abcBD16989F875707}

e() { echo "  $*"; }

echo "== distributing tokens =="
for pair in "$ALICE 200000" "$BOB 120000" "$CAROL 60000"; do
  set -- $pair
  cast send "$TOKEN" 'transfer(address,uint256)' "$1" "$(cast to-wei "$2")" \
    --private-key "$DEPLOYER_KEY" --rpc-url "$RPC" >/dev/null
  e "$2 PRJ -> $1"
done

echo "== staking =="
stake() {
  local key=$1 amount=$2 who=$3
  cast send "$TOKEN" 'approve(address,uint256)' "$VAULT" "$(cast to-wei "$amount")" \
    --private-key "$key" --rpc-url "$RPC" >/dev/null
  cast send "$VAULT" 'deposit(uint256,address)' "$(cast to-wei "$amount")" "$who" \
    --private-key "$key" --rpc-url "$RPC" >/dev/null
  e "$who staked $amount PRJ"
}
stake "$ALICE_KEY" 180000 "$ALICE"
stake "$BOB_KEY" 95000 "$BOB"
stake "$CAROL_KEY" 41000 "$CAROL"

# The vault and the vesting contract are owned by the timelock, which on a live chain is only
# reachable by passing a governance proposal. Anvil can impersonate it directly, which is the
# normal way to set up local state without waiting out a voting period.
echo "== impersonating the timelock =="
cast rpc anvil_impersonateAccount "$TIMELOCK" --rpc-url "$RPC" >/dev/null
cast rpc anvil_setBalance "$TIMELOCK" 0xde0b6b3a7640000 --rpc-url "$RPC" >/dev/null

echo "== funding staking rewards =="
# notifyRewardAmount pulls the tokens from the caller, so the timelock needs both the balance and
# an allowance. Sending straight to the vault would leave them stranded.
cast send "$TOKEN" 'transfer(address,uint256)' "$TIMELOCK" "$(cast to-wei 6000)" \
  --private-key "$DEPLOYER_KEY" --rpc-url "$RPC" >/dev/null
cast send "$TOKEN" 'approve(address,uint256)' "$VAULT" "$(cast to-wei 6000)" \
  --from "$TIMELOCK" --unlocked --rpc-url "$RPC" >/dev/null
cast send "$VAULT" 'notifyRewardAmount(uint256)' "$(cast to-wei 6000)" \
  --from "$TIMELOCK" --unlocked --rpc-url "$RPC" >/dev/null
e "6000 PRJ streaming over the reward duration"

echo "== creating vesting schedules =="
# The timelock has to hold the tokens, since createSchedule pulls them from the caller.
cast send "$TOKEN" 'transfer(address,uint256)' "$TIMELOCK" "$(cast to-wei 750000)" \
  --private-key "$DEPLOYER_KEY" --rpc-url "$RPC" >/dev/null
cast send "$TOKEN" 'approve(address,uint256)' "$VESTING" "$(cast to-wei 750000)" \
  --from "$TIMELOCK" --unlocked --rpc-url "$RPC" >/dev/null

NOW=$(cast block latest --field timestamp --rpc-url "$RPC")
DAY=86400

# Partly vested, still inside its cliff, and fully vested: the three states worth showing.
cast send "$VESTING" 'createSchedule(address,uint128,uint64,uint64,uint64,bool)' \
  "$ALICE" "$(cast to-wei 250000)" "$((NOW - 120 * DAY))" "$((90 * DAY))" "$((730 * DAY))" true \
  --from "$TIMELOCK" --unlocked --rpc-url "$RPC" >/dev/null
e "alice   250000 PRJ over 2 years, 90 day cliff, 120 days in"

cast send "$VESTING" 'createSchedule(address,uint128,uint64,uint64,uint64,bool)' \
  "$BOB" "$(cast to-wei 400000)" "$((NOW - 30 * DAY))" "$((180 * DAY))" "$((1095 * DAY))" true \
  --from "$TIMELOCK" --unlocked --rpc-url "$RPC" >/dev/null
e "bob     400000 PRJ over 3 years, still inside its cliff"

cast send "$VESTING" 'createSchedule(address,uint128,uint64,uint64,uint64,bool)' \
  "$CAROL" "$(cast to-wei 100000)" "$((NOW - 800 * DAY))" 0 "$((365 * DAY))" false \
  --from "$TIMELOCK" --unlocked --rpc-url "$RPC" >/dev/null
e "carol   100000 PRJ fully vested"

cast rpc anvil_stopImpersonatingAccount "$TIMELOCK" --rpc-url "$RPC" >/dev/null

echo "== delegating votes =="
for pair in "$ALICE_KEY $ALICE" "$BOB_KEY $BOB" "$CAROL_KEY $ALICE"; do
  set -- $pair
  cast send "$TOKEN" 'delegate(address)' "$2" --private-key "$1" --rpc-url "$RPC" >/dev/null
done
e "carol delegates to alice"

echo
echo "== on-chain state =="
echo "  vault totalAssets   $(cast call "$VAULT" 'totalAssets()(uint256)' --rpc-url "$RPC")"
echo "  vault pricePerShare $(cast call "$VAULT" 'pricePerShare()(uint256)' --rpc-url "$RPC")"
echo "  vault apr bps       $(cast call "$VAULT" 'currentApr()(uint256)' --rpc-url "$RPC")"
echo "  vesting schedules   $(cast call "$VESTING" 'scheduleCount()(uint256)' --rpc-url "$RPC")"
