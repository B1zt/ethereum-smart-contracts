// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MerkleDistributor} from "../src/MerkleDistributor.sol";
import {ProjectToken} from "../src/ProjectToken.sol";
import {MerkleLib} from "./utils/MerkleLib.sol";

contract MerkleDistributorTest is Test {
    ProjectToken internal token;
    MerkleDistributor internal distributor;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");

    uint256 internal constant CLAIMANTS = 8;
    uint256 internal constant AMOUNT = 1_000e18;
    uint256 internal deadline;

    bytes32[] internal leaves;
    address[] internal claimants;

    function setUp() public {
        vm.warp(1_800_000_000);
        deadline = block.timestamp + 90 days;

        token = new ProjectToken("Project", "PRJ", 1_000_000_000e18, 100_000_000e18, treasury, admin);

        // Allocation grows with the index, so a test that mixes up indices produces a wrong amount
        // rather than accidentally passing.
        for (uint256 i; i < CLAIMANTS; ++i) {
            address claimant = address(uint160(0x1000 + i));
            claimants.push(claimant);
            leaves.push(_leaf(i, claimant, AMOUNT * (i + 1)));
        }

        _sortLeaves();

        distributor =
            new MerkleDistributor(IERC20(address(token)), MerkleLib.getRoot(leaves), deadline, admin);

        // Fund the airdrop.
        uint256 total;
        for (uint256 i; i < CLAIMANTS; ++i) {
            total += AMOUNT * (i + 1);
        }

        vm.prank(treasury);
        token.transfer(address(distributor), total);
    }

    function _leaf(uint256 index, address account, uint256 amount) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))));
    }

    /// @dev The tree builder assumes sorted leaves, matching how the backend builds it.
    function _sortLeaves() internal {
        for (uint256 i = 1; i < leaves.length; ++i) {
            bytes32 key = leaves[i];
            uint256 j = i;
            while (j > 0 && leaves[j - 1] > key) {
                leaves[j] = leaves[j - 1];
                --j;
            }
            leaves[j] = key;
        }
    }

    function _indexOf(bytes32 target) internal view returns (uint256) {
        for (uint256 i; i < leaves.length; ++i) {
            if (leaves[i] == target) return i;
        }
        revert("leaf not found");
    }

    function _proofFor(uint256 index, address account, uint256 amount)
        internal
        view
        returns (bytes32[] memory)
    {
        return MerkleLib.getProof(leaves, _indexOf(_leaf(index, account, amount)));
    }

    /*//////////////////////////////////////////////////////////////
                               CLAIMING
    //////////////////////////////////////////////////////////////*/

    function test_claim_happyPath() public {
        uint256 index = 3;
        address claimant = claimants[index];
        uint256 amount = AMOUNT * (index + 1);

        distributor.claim(index, claimant, amount, _proofFor(index, claimant, amount));

        assertEq(token.balanceOf(claimant), amount);
        assertTrue(distributor.isClaimed(index));
        assertEq(distributor.totalClaimed(), amount);
        assertEq(distributor.claimCount(), 1);
    }

    function test_claim_cannotClaimTwice() public {
        uint256 index = 0;
        address claimant = claimants[index];
        uint256 amount = AMOUNT;
        bytes32[] memory proof = _proofFor(index, claimant, amount);

        distributor.claim(index, claimant, amount, proof);

        vm.expectRevert(abi.encodeWithSelector(MerkleDistributor.AlreadyClaimed.selector, index));
        distributor.claim(index, claimant, amount, proof);
    }

    /// @dev The leaf binds the allocation to a specific address, so a valid proof cannot be
    ///      redirected by whoever submits the transaction.
    function test_claim_alwaysPaysTheLeafAddress() public {
        uint256 index = 2;
        address claimant = claimants[index];
        uint256 amount = AMOUNT * 3;

        address relayer = makeAddr("relayer");
        vm.prank(relayer);
        distributor.claim(index, claimant, amount, _proofFor(index, claimant, amount));

        assertEq(token.balanceOf(claimant), amount, "leaf address paid");
        assertEq(token.balanceOf(relayer), 0, "relayer gets nothing");
    }

    function test_claim_rejectsInflatedAmount() public {
        uint256 index = 1;
        address claimant = claimants[index];

        vm.expectRevert(MerkleDistributor.InvalidProof.selector);
        distributor.claim(index, claimant, AMOUNT * 999, _proofFor(index, claimant, AMOUNT * 2));
    }

    function test_claim_rejectsWrongAccount() public {
        uint256 index = 1;
        uint256 amount = AMOUNT * 2;
        bytes32[] memory proof = _proofFor(index, claimants[index], amount);

        vm.expectRevert(MerkleDistributor.InvalidProof.selector);
        distributor.claim(index, makeAddr("mallory"), amount, proof);
    }

    function test_claim_rejectsMismatchedIndex() public {
        uint256 amount = AMOUNT;
        bytes32[] memory proof = _proofFor(0, claimants[0], amount);

        vm.expectRevert(MerkleDistributor.InvalidProof.selector);
        distributor.claim(5, claimants[0], amount, proof);
    }

    function test_claim_revertsAfterDeadline() public {
        vm.warp(deadline + 1);

        vm.expectRevert(abi.encodeWithSelector(MerkleDistributor.ClaimWindowClosed.selector, deadline));
        distributor.claim(0, claimants[0], AMOUNT, _proofFor(0, claimants[0], AMOUNT));
    }

    function test_claimMany() public {
        uint256[] memory indices = new uint256[](3);
        address[] memory accounts = new address[](3);
        uint256[] memory amounts = new uint256[](3);
        bytes32[][] memory proofs = new bytes32[][](3);

        for (uint256 i; i < 3; ++i) {
            indices[i] = i;
            accounts[i] = claimants[i];
            amounts[i] = AMOUNT * (i + 1);
            proofs[i] = _proofFor(i, claimants[i], amounts[i]);
        }

        distributor.claimMany(indices, accounts, amounts, proofs);

        for (uint256 i; i < 3; ++i) {
            assertEq(token.balanceOf(claimants[i]), AMOUNT * (i + 1));
        }
        assertEq(distributor.claimCount(), 3);
    }

    function test_claimMany_rejectsLengthMismatch() public {
        uint256[] memory indices = new uint256[](2);
        address[] memory accounts = new address[](1);
        uint256[] memory amounts = new uint256[](2);
        bytes32[][] memory proofs = new bytes32[][](2);

        vm.expectRevert(MerkleDistributor.LengthMismatch.selector);
        distributor.claimMany(indices, accounts, amounts, proofs);
    }

    /*//////////////////////////////////////////////////////////////
                                 BITMAP
    //////////////////////////////////////////////////////////////*/

    /// @dev Independent bits in the same word must not interfere. This is the property that makes
    ///      the bitmap optimisation safe rather than merely cheap.
    function test_bitmapTracksIndicesIndependently() public {
        for (uint256 i; i < CLAIMANTS; ++i) {
            assertFalse(distributor.isClaimed(i));
        }

        uint256 amount = AMOUNT * 4;
        distributor.claim(3, claimants[3], amount, _proofFor(3, claimants[3], amount));

        for (uint256 i; i < CLAIMANTS; ++i) {
            assertEq(distributor.isClaimed(i), i == 3, "only index 3 is set");
        }

        // Bit 3 of word 0.
        assertEq(distributor.claimedBitMap(0), 1 << 3);
    }

    /*//////////////////////////////////////////////////////////////
                                 SWEEP
    //////////////////////////////////////////////////////////////*/

    function test_sweep_revertsBeforeDeadline() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(MerkleDistributor.ClaimWindowStillOpen.selector, deadline));
        distributor.sweep(admin);
    }

    function test_sweep_recoversUnclaimedAfterDeadline() public {
        uint256 amount = AMOUNT;
        distributor.claim(0, claimants[0], amount, _proofFor(0, claimants[0], amount));

        vm.warp(deadline + 1);

        uint256 remaining = token.balanceOf(address(distributor));

        vm.prank(admin);
        distributor.sweep(admin);

        assertEq(token.balanceOf(admin), remaining);
        assertEq(token.balanceOf(address(distributor)), 0);
    }

    function test_sweep_onlyOwner() public {
        vm.warp(deadline + 1);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        distributor.sweep(address(this));
    }

    /// @dev `sweepOther` must not become a back door around the claim window.
    function test_sweepOther_cannotTouchAirdropToken() public {
        vm.prank(admin);
        vm.expectRevert(MerkleDistributor.NothingToSweep.selector);
        distributor.sweepOther(IERC20(address(token)), admin);
    }

    /*//////////////////////////////////////////////////////////////
                                 FUZZ
    //////////////////////////////////////////////////////////////*/

    /// @dev Every claimant can claim exactly once, for exactly their allocation, in any order.
    function testFuzz_everyClaimantCanClaimOnce(uint8 seed) public {
        uint256 offset = bound(seed, 0, CLAIMANTS - 1);
        uint256 distributed;

        for (uint256 step; step < CLAIMANTS; ++step) {
            uint256 index = (offset + step) % CLAIMANTS;
            uint256 amount = AMOUNT * (index + 1);

            distributor.claim(index, claimants[index], amount, _proofFor(index, claimants[index], amount));
            distributed += amount;

            assertEq(token.balanceOf(claimants[index]), amount);
        }

        assertEq(distributor.totalClaimed(), distributed);
        assertEq(distributor.claimCount(), CLAIMANTS);
        assertEq(token.balanceOf(address(distributor)), 0, "airdrop fully distributed");
    }
}
