// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ProjectToken} from "../src/ProjectToken.sol";
import {TokenVesting} from "../src/TokenVesting.sol";

contract TokenVestingTest is Test {
    ProjectToken internal token;
    TokenVesting internal vesting;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal constant CAP = 1_000_000_000e18;
    uint256 internal constant INITIAL = 100_000_000e18;

    uint64 internal start;
    uint64 internal constant CLIFF = 365 days;
    uint64 internal constant DURATION = 4 * 365 days;
    uint128 internal constant GRANT = 1_000_000e18;

    function setUp() public {
        vm.warp(1_800_000_000);
        start = uint64(block.timestamp);

        token = new ProjectToken("Project", "PRJ", CAP, INITIAL, treasury, admin);
        vesting = new TokenVesting(IERC20(address(token)), admin);

        // The owner funds schedules, so it needs both the tokens and an approval.
        vm.prank(treasury);
        token.transfer(admin, INITIAL);

        vm.prank(admin);
        token.approve(address(vesting), type(uint256).max);
    }

    function _createSchedule(address beneficiary, bool revocable) internal returns (uint256) {
        vm.prank(admin);
        return vesting.createSchedule(beneficiary, GRANT, start, CLIFF, DURATION, revocable);
    }

    /*//////////////////////////////////////////////////////////////
                               CREATION
    //////////////////////////////////////////////////////////////*/

    function test_createSchedule_pullsTokensUpFront() public {
        uint256 id = _createSchedule(alice, false);

        assertEq(token.balanceOf(address(vesting)), GRANT, "contract funded at creation");
        assertEq(vesting.totalCommitted(), GRANT);

        TokenVesting.Schedule memory schedule = vesting.schedules(id);
        assertEq(schedule.beneficiary, alice);
        assertEq(schedule.total, GRANT);
        assertEq(schedule.released, 0);
    }

    function test_createSchedule_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vesting.createSchedule(alice, GRANT, start, CLIFF, DURATION, false);
    }

    function test_createSchedule_rejectsCliffLongerThanDuration() public {
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(TokenVesting.CliffLongerThanDuration.selector, DURATION + 1, DURATION)
        );
        vesting.createSchedule(alice, GRANT, start, DURATION + 1, DURATION, false);
    }

    function test_createSchedule_rejectsZeroDuration() public {
        vm.prank(admin);
        vm.expectRevert(TokenVesting.ZeroDuration.selector);
        vesting.createSchedule(alice, GRANT, start, 0, 0, false);
    }

    function test_createSchedules_batch() public {
        address[] memory beneficiaries = new address[](2);
        beneficiaries[0] = alice;
        beneficiaries[1] = bob;

        uint128[] memory amounts = new uint128[](2);
        amounts[0] = GRANT;
        amounts[1] = GRANT * 2;

        vm.prank(admin);
        vesting.createSchedules(beneficiaries, amounts, start, CLIFF, DURATION, false);

        assertEq(vesting.scheduleCount(), 2);
        assertEq(vesting.totalCommitted(), GRANT * 3);
    }

    function test_createSchedules_rejectsLengthMismatch() public {
        address[] memory beneficiaries = new address[](2);
        uint128[] memory amounts = new uint128[](1);

        vm.prank(admin);
        vm.expectRevert(TokenVesting.LengthMismatch.selector);
        vesting.createSchedules(beneficiaries, amounts, start, CLIFF, DURATION, false);
    }

    /*//////////////////////////////////////////////////////////////
                             VESTING CURVE
    //////////////////////////////////////////////////////////////*/

    function test_nothingVestsBeforeCliff() public {
        uint256 id = _createSchedule(alice, false);

        vm.warp(start + CLIFF - 1);
        assertEq(vesting.vestedAmount(id), 0);

        vm.expectRevert(TokenVesting.NothingToRelease.selector);
        vesting.release(id);
    }

    /// @dev Crossing the cliff releases everything accrued during it as one tranche, because vesting
    ///      is measured linearly from `start` rather than from the end of the cliff.
    function test_cliffUnlocksAccruedAmountAtOnce() public {
        uint256 id = _createSchedule(alice, false);

        vm.warp(start + CLIFF);

        uint256 expected = (uint256(GRANT) * CLIFF) / DURATION; // 1 of 4 years
        assertEq(vesting.vestedAmount(id), expected);
        assertApproxEqRel(expected, GRANT / 4, 0.0001e18, "roughly a quarter");
    }

    function test_linearVestingAfterCliff() public {
        uint256 id = _createSchedule(alice, false);

        vm.warp(start + DURATION / 2);
        assertEq(vesting.vestedAmount(id), GRANT / 2);

        vm.warp(start + (DURATION * 3) / 4);
        assertEq(vesting.vestedAmount(id), (uint256(GRANT) * 3) / 4);
    }

    function test_fullyVestedAtEnd() public {
        uint256 id = _createSchedule(alice, false);

        vm.warp(start + DURATION);
        assertEq(vesting.vestedAmount(id), GRANT);

        // And it does not keep growing past the end.
        vm.warp(start + DURATION * 10);
        assertEq(vesting.vestedAmount(id), GRANT);
    }

    /*//////////////////////////////////////////////////////////////
                                RELEASE
    //////////////////////////////////////////////////////////////*/

    function test_release_transfersToBeneficiary() public {
        uint256 id = _createSchedule(alice, false);

        vm.warp(start + DURATION / 2);
        vesting.release(id);

        assertEq(token.balanceOf(alice), GRANT / 2);
        assertEq(vesting.releasableAmount(id), 0);
    }

    /// @dev Anyone may trigger a release, but the tokens always go to the beneficiary. That lets a
    ///      project pay gas for users without being able to redirect their allocation.
    function test_release_isPermissionlessButPaysBeneficiary() public {
        uint256 id = _createSchedule(alice, false);

        vm.warp(start + DURATION);

        vm.prank(bob);
        vesting.release(id);

        assertEq(token.balanceOf(alice), GRANT, "beneficiary paid");
        assertEq(token.balanceOf(bob), 0, "caller gets nothing");
    }

    function test_release_incrementalClaimsSumToTotal() public {
        uint256 id = _createSchedule(alice, false);

        vm.warp(start + CLIFF);
        vesting.release(id);

        vm.warp(start + DURATION / 2);
        vesting.release(id);

        vm.warp(start + DURATION);
        vesting.release(id);

        assertEq(token.balanceOf(alice), GRANT, "no double counting, no shortfall");
    }

    function test_releaseMany() public {
        uint256 first = _createSchedule(alice, false);
        uint256 second = _createSchedule(alice, false);

        vm.warp(start + DURATION);

        uint256[] memory ids = new uint256[](2);
        ids[0] = first;
        ids[1] = second;

        vesting.releaseMany(ids);
        assertEq(token.balanceOf(alice), uint256(GRANT) * 2);
    }

    function test_totalReleasableOf_sumsAcrossSchedules() public {
        _createSchedule(alice, false);
        _createSchedule(alice, false);

        vm.warp(start + DURATION / 2);
        assertEq(vesting.totalReleasableOf(alice), GRANT);
    }

    /*//////////////////////////////////////////////////////////////
                              REVOCATION
    //////////////////////////////////////////////////////////////*/

    /// @dev The core guarantee: revoking returns only the unvested remainder. Everything already
    ///      earned is paid to the beneficiary first, in the same transaction.
    function test_revoke_paysVestedThenRefundsRemainder() public {
        uint256 id = _createSchedule(alice, true);

        vm.warp(start + DURATION / 2);

        uint256 adminBefore = token.balanceOf(admin);

        vm.prank(admin);
        vesting.revoke(id);

        assertEq(token.balanceOf(alice), GRANT / 2, "beneficiary keeps what vested");
        assertEq(token.balanceOf(admin) - adminBefore, GRANT / 2, "owner gets the unvested half");
        assertEq(vesting.totalCommitted(), 0);
    }

    /// @dev Tokens already claimed are never clawed back.
    function test_revoke_doesNotClawBackAlreadyReleased() public {
        uint256 id = _createSchedule(alice, true);

        vm.warp(start + DURATION / 2);
        vesting.release(id);
        assertEq(token.balanceOf(alice), GRANT / 2);

        vm.prank(admin);
        vesting.revoke(id);

        assertEq(token.balanceOf(alice), GRANT / 2, "unchanged by revocation");
    }

    function test_revoke_freezesVestingAtRevocationTime() public {
        uint256 id = _createSchedule(alice, true);

        vm.warp(start + DURATION / 2);
        vm.prank(admin);
        vesting.revoke(id);

        // Time keeps passing, but nothing further accrues.
        vm.warp(start + DURATION * 2);
        assertEq(vesting.vestedAmount(id), GRANT / 2);
        assertEq(vesting.releasableAmount(id), 0);
    }

    function test_revoke_revertsIfNotRevocable() public {
        uint256 id = _createSchedule(alice, false);

        vm.prank(admin);
        vm.expectRevert(TokenVesting.NotRevocable.selector);
        vesting.revoke(id);
    }

    function test_revoke_cannotRevokeTwice() public {
        uint256 id = _createSchedule(alice, true);

        vm.startPrank(admin);
        vesting.revoke(id);

        vm.expectRevert(TokenVesting.AlreadyRevoked.selector);
        vesting.revoke(id);
        vm.stopPrank();
    }

    function test_revoke_onlyOwner() public {
        uint256 id = _createSchedule(alice, true);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vesting.revoke(id);
    }

    /*//////////////////////////////////////////////////////////////
                                 SWEEP
    //////////////////////////////////////////////////////////////*/

    /// @dev The owner must never be able to sweep tokens a beneficiary is still owed.
    function test_sweep_cannotTouchCommittedTokens() public {
        _createSchedule(alice, false);

        vm.prank(admin);
        vm.expectRevert(TokenVesting.NothingToSweep.selector);
        vesting.sweep(IERC20(address(token)), admin);
    }

    function test_sweep_recoversOnlySurplus() public {
        _createSchedule(alice, false);

        // Someone sends tokens here by mistake.
        vm.prank(admin);
        token.transfer(address(vesting), 500e18);

        uint256 adminBefore = token.balanceOf(admin);

        vm.prank(admin);
        vesting.sweep(IERC20(address(token)), admin);

        assertEq(token.balanceOf(admin) - adminBefore, 500e18, "only the surplus moved");
        assertEq(token.balanceOf(address(vesting)), GRANT, "the grant is untouched");
    }

    /*//////////////////////////////////////////////////////////////
                                 FUZZ
    //////////////////////////////////////////////////////////////*/

    /// @dev Vested is monotonic and never exceeds the grant, at any point in time.
    function testFuzz_vestedIsMonotonicAndBounded(uint64 elapsed) public {
        uint256 id = _createSchedule(alice, false);
        elapsed = uint64(bound(elapsed, 0, DURATION * 3));

        vm.warp(start + elapsed);
        uint256 first = vesting.vestedAmount(id);

        assertLe(first, GRANT, "never exceeds the grant");

        vm.warp(start + elapsed + 1 days);
        assertGe(vesting.vestedAmount(id), first, "never decreases");
    }

    /// @dev However a claim is split up in time, the beneficiary ends with exactly the grant.
    function testFuzz_partialClaimsSumToGrant(uint64 firstClaim, uint64 secondClaim) public {
        uint256 id = _createSchedule(alice, false);

        uint64 a = uint64(bound(firstClaim, CLIFF, DURATION));
        uint64 b = uint64(bound(secondClaim, a, DURATION));

        vm.warp(start + a);
        if (vesting.releasableAmount(id) > 0) vesting.release(id);

        vm.warp(start + b);
        if (vesting.releasableAmount(id) > 0) vesting.release(id);

        vm.warp(start + DURATION);
        if (vesting.releasableAmount(id) > 0) vesting.release(id);

        assertEq(token.balanceOf(alice), GRANT);
    }

    /// @dev Whatever the split, beneficiary plus owner always ends up with exactly the grant.
    function testFuzz_revocationConservesValue(uint64 revokeAt) public {
        uint256 id = _createSchedule(alice, true);
        revokeAt = uint64(bound(revokeAt, 0, DURATION * 2));

        uint256 adminBefore = token.balanceOf(admin);

        vm.warp(start + revokeAt);
        vm.prank(admin);
        vesting.revoke(id);

        uint256 toBeneficiary = token.balanceOf(alice);
        uint256 toOwner = token.balanceOf(admin) - adminBefore;

        assertEq(toBeneficiary + toOwner, GRANT, "value conserved");
        assertEq(vesting.totalCommitted(), 0);
    }
}
