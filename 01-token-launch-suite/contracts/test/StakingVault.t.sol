// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ProjectToken} from "../src/ProjectToken.sol";
import {StakingVault} from "../src/StakingVault.sol";

contract StakingVaultTest is Test {
    ProjectToken internal token;
    StakingVault internal vault;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint64 internal constant REWARD_DURATION = 30 days;
    uint256 internal constant STAKE = 1_000e18;

    function setUp() public {
        vm.warp(1_800_000_000);

        token = new ProjectToken("Project", "PRJ", 1_000_000_000e18, 100_000_000e18, treasury, admin);
        vault = new StakingVault(IERC20(address(token)), "Staked PRJ", "sPRJ", REWARD_DURATION, admin);

        vm.startPrank(treasury);
        token.transfer(alice, 100_000e18);
        token.transfer(bob, 100_000e18);
        token.transfer(admin, 1_000_000e18);
        vm.stopPrank();

        vm.prank(alice);
        token.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        token.approve(address(vault), type(uint256).max);
        vm.prank(admin);
        token.approve(address(vault), type(uint256).max);
    }

    function _addRewards(uint256 amount) internal {
        vm.prank(admin);
        vault.notifyRewardAmount(amount);
    }

    /*//////////////////////////////////////////////////////////////
                             BASIC ERC-4626
    //////////////////////////////////////////////////////////////*/

    function test_depositMintsShares() public {
        vm.prank(alice);
        uint256 shares = vault.deposit(STAKE, alice);

        assertGt(shares, 0);
        assertEq(vault.balanceOf(alice), shares);
        assertEq(vault.totalAssets(), STAKE);
        assertEq(vault.convertToAssets(shares), STAKE);
    }

    function test_withdrawReturnsAssets() public {
        vm.startPrank(alice);
        vault.deposit(STAKE, alice);
        vault.withdraw(STAKE, alice, alice);
        vm.stopPrank();

        assertEq(vault.totalAssets(), 0);
        assertEq(vault.balanceOf(alice), 0);
    }

    function test_redeemAllShares() public {
        vm.startPrank(alice);
        uint256 shares = vault.deposit(STAKE, alice);
        uint256 assets = vault.redeem(shares, alice, alice);
        vm.stopPrank();

        assertEq(assets, STAKE);
    }

    /*//////////////////////////////////////////////////////////////
                           INFLATION ATTACK
    //////////////////////////////////////////////////////////////*/

    /// @dev The classic ERC-4626 first-depositor attack: deposit 1 wei, donate a large amount
    ///      directly, and hope the next depositor's shares round to zero. The virtual-share defence
    ///      plus a 6 decimal offset must make the victim's shares non-zero and their claim fair.
    function test_inflationAttackFails() public {
        address attacker = makeAddr("attacker");

        vm.prank(treasury);
        token.transfer(attacker, 10_000e18);

        vm.startPrank(attacker);
        token.approve(address(vault), type(uint256).max);

        // Step 1: mint the smallest possible share position.
        vault.deposit(1, attacker);

        // Step 2: donate directly to inflate the share price.
        token.transfer(address(vault), 1_000e18);
        vm.stopPrank();

        // Step 3: the victim deposits.
        vm.prank(alice);
        uint256 victimShares = vault.deposit(STAKE, alice);

        assertGt(victimShares, 0, "victim must receive non-zero shares");

        // The victim can withdraw substantially what they put in. The tiny shortfall is the
        // rounding the virtual offset introduces, and it is a rounding error rather than a loss.
        uint256 victimAssets = vault.convertToAssets(victimShares);
        assertApproxEqRel(victimAssets, STAKE, 0.01e18, "victim keeps their deposit");

        // And the attack was not profitable: the attacker cannot recover their donation.
        vm.prank(attacker);
        uint256 attackerAssets = vault.convertToAssets(vault.balanceOf(attacker));
        assertLt(attackerAssets, 1_000e18, "attacker lost the donation");
    }

    /*//////////////////////////////////////////////////////////////
                            REWARD STREAMING
    //////////////////////////////////////////////////////////////*/

    /// @dev The core anti-dilution property. If rewards counted immediately, a depositor entering
    ///      in the same block as the reward would capture a share of it for free.
    function test_rewardsDoNotCountUntilStreamed() public {
        vm.prank(alice);
        vault.deposit(STAKE, alice);

        uint256 assetsBefore = vault.totalAssets();
        _addRewards(1_000e18);

        assertEq(vault.totalAssets(), assetsBefore, "nothing counts immediately");
        assertEq(vault.lockedRewards(), 1_000e18);
    }

    function test_rewardsStreamLinearly() public {
        vm.prank(alice);
        vault.deposit(STAKE, alice);

        _addRewards(1_000e18);

        vm.warp(block.timestamp + REWARD_DURATION / 2);
        assertApproxEqRel(vault.totalAssets(), STAKE + 500e18, 0.001e18, "half streamed");

        vm.warp(block.timestamp + REWARD_DURATION / 2);
        assertEq(vault.totalAssets(), STAKE + 1_000e18, "fully streamed");
        assertEq(vault.lockedRewards(), 0);
    }

    /// @dev A late depositor must not be able to capture rewards accrued before they arrived.
    function test_lateDepositorDoesNotStealEarlierRewards() public {
        vm.prank(alice);
        vault.deposit(STAKE, alice);

        _addRewards(1_000e18);

        // Stream fully, so all rewards belong to Alice.
        vm.warp(block.timestamp + REWARD_DURATION);

        vm.prank(bob);
        vault.deposit(STAKE, bob);

        uint256 aliceAssets = vault.convertToAssets(vault.balanceOf(alice));
        uint256 bobAssets = vault.convertToAssets(vault.balanceOf(bob));

        assertApproxEqRel(aliceAssets, STAKE + 1_000e18, 0.001e18, "alice keeps the rewards");
        assertApproxEqRel(bobAssets, STAKE, 0.001e18, "bob gets exactly what he put in");
    }

    /// @dev Two stakers present for the whole stream split rewards in proportion to their stake.
    function test_rewardsSplitByStake() public {
        vm.prank(alice);
        vault.deposit(STAKE, alice);
        vm.prank(bob);
        vault.deposit(STAKE * 3, bob);

        _addRewards(4_000e18);
        vm.warp(block.timestamp + REWARD_DURATION);

        uint256 aliceGain = vault.convertToAssets(vault.balanceOf(alice)) - STAKE;
        uint256 bobGain = vault.convertToAssets(vault.balanceOf(bob)) - STAKE * 3;

        assertApproxEqRel(aliceGain, 1_000e18, 0.001e18, "alice: 1/4 of rewards");
        assertApproxEqRel(bobGain, 3_000e18, 0.001e18, "bob: 3/4 of rewards");
    }

    function test_addingRewardsMidStreamExtendsIt() public {
        vm.prank(alice);
        vault.deposit(STAKE, alice);

        _addRewards(1_000e18);
        vm.warp(block.timestamp + REWARD_DURATION / 2);

        // Roughly 500 has streamed, 500 is still locked.
        _addRewards(1_000e18);
        assertApproxEqRel(vault.lockedRewards(), 1_500e18, 0.01e18, "remainder folded in");

        vm.warp(block.timestamp + REWARD_DURATION);
        assertEq(vault.lockedRewards(), 0);
        assertEq(vault.totalAssets(), STAKE + 2_000e18, "everything eventually streams");
    }

    function test_notifyRewardAmount_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.notifyRewardAmount(1_000e18);
    }

    /*//////////////////////////////////////////////////////////////
                                COOLDOWN
    //////////////////////////////////////////////////////////////*/

    function test_cooldownBlocksEarlyWithdrawal() public {
        vm.prank(admin);
        vault.setCooldown(7 days);

        vm.startPrank(alice);
        vault.deposit(STAKE, alice);

        uint256 unlocksAt = vault.unlocksAt(alice);
        vm.expectRevert(abi.encodeWithSelector(StakingVault.StillCoolingDown.selector, unlocksAt));
        vault.withdraw(STAKE, alice, alice);
        vm.stopPrank();

        vm.warp(block.timestamp + 7 days);

        vm.prank(alice);
        vault.withdraw(STAKE, alice, alice);
        assertEq(vault.balanceOf(alice), 0);
    }

    /// @dev An owner must not be able to lock stakers in indefinitely.
    function test_cooldownIsCapped() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(StakingVault.CooldownTooLong.selector, uint64(31 days)));
        vault.setCooldown(31 days);
    }

    function test_cooldownRemaining() public {
        vm.prank(admin);
        vault.setCooldown(7 days);

        vm.prank(alice);
        vault.deposit(STAKE, alice);

        assertEq(vault.cooldownRemaining(alice), 7 days);

        vm.warp(block.timestamp + 3 days);
        assertEq(vault.cooldownRemaining(alice), 4 days);

        vm.warp(block.timestamp + 10 days);
        assertEq(vault.cooldownRemaining(alice), 0);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    function test_pricePerShareRisesWithRewards() public {
        vm.prank(alice);
        vault.deposit(STAKE, alice);

        uint256 before = vault.pricePerShare();

        _addRewards(1_000e18);
        vm.warp(block.timestamp + REWARD_DURATION);

        assertGt(vault.pricePerShare(), before, "share price rose");
    }

    function test_currentApr() public {
        vm.prank(alice);
        vault.deposit(1_000e18, alice);

        assertEq(vault.currentApr(), 0, "no rewards, no APR");

        _addRewards(100e18);

        // 100 over 30 days on 1000 staked is about 121% annualised.
        uint256 apr = vault.currentApr();
        assertGt(apr, 10_000, "meaningfully above 100%");
        assertLt(apr, 20_000);
    }

    /*//////////////////////////////////////////////////////////////
                                 FUZZ
    //////////////////////////////////////////////////////////////*/

    /// @dev A deposit followed immediately by a withdrawal must never return more than went in.
    ///      Anything else is free money and a drain vector.
    function testFuzz_roundTripNeverProfits(uint256 amount) public {
        amount = bound(amount, 1e6, 50_000e18);

        vm.startPrank(alice);
        uint256 shares = vault.deposit(amount, alice);
        uint256 returned = vault.redeem(shares, alice, alice);
        vm.stopPrank();

        assertLe(returned, amount, "round trip cannot profit");
    }

    /// @dev Two depositors of the same size, present for the same period, must end up equal.
    function testFuzz_equalStakesEarnEqualRewards(uint96 rewardAmount) public {
        uint256 rewards = bound(uint256(rewardAmount), 1e18, 100_000e18);

        vm.prank(alice);
        vault.deposit(STAKE, alice);
        vm.prank(bob);
        vault.deposit(STAKE, bob);

        vm.prank(treasury);
        token.transfer(admin, rewards);
        _addRewards(rewards);

        vm.warp(block.timestamp + REWARD_DURATION);

        uint256 aliceAssets = vault.convertToAssets(vault.balanceOf(alice));
        uint256 bobAssets = vault.convertToAssets(vault.balanceOf(bob));

        assertApproxEqAbs(aliceAssets, bobAssets, 1, "equal stakes, equal outcome");
    }

    /// @dev Shares outstanding must always be redeemable from real assets held.
    function testFuzz_vaultIsAlwaysSolvent(uint96 depositA, uint96 depositB, uint96 rewards) public {
        uint256 a = bound(uint256(depositA), 1e6, 50_000e18);
        uint256 b = bound(uint256(depositB), 1e6, 50_000e18);
        uint256 r = bound(uint256(rewards), 0, 50_000e18);

        vm.prank(alice);
        vault.deposit(a, alice);
        vm.prank(bob);
        vault.deposit(b, bob);

        if (r > 0) {
            vm.prank(treasury);
            token.transfer(admin, r);
            _addRewards(r);
            vm.warp(block.timestamp + REWARD_DURATION);
        }

        uint256 owed = vault.convertToAssets(vault.totalSupply());
        assertLe(owed, token.balanceOf(address(vault)), "vault can honour every share");
    }
}
