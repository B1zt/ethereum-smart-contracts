// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MerkleDistributor} from "../src/MerkleDistributor.sol";
import {ProjectToken} from "../src/ProjectToken.sol";
import {MerkleLib} from "./utils/MerkleLib.sol";

/// @notice Proves the off-chain airdrop tree and the on-chain verifier agree.
///
/// @dev The tree is built by the backend and verified by `MerkleDistributor.claim`. Nothing forces
///      the two to agree, and when they disagree the failure is silent and total: the API serves
///      well-formed proofs and every claim reverts with `InvalidProof`.
///
///      Both sides build from the same fixed entry set and assert the same root constant. The
///      TypeScript twin is `backend/src/airdrop/tree.test.ts`.
///
///      Note the ordering difference from an allowlist tree: leaves are kept in **index order**,
///      not sorted by leaf hash. The index addresses a bit in the on-chain claim bitmap, so it must
///      stay dense and stable, and reordering after publication would invalidate every claim.
contract AirdropCrossCheckTest is Test {
    /// @dev Must match SHARED_FIXTURE_ROOT in backend/src/airdrop/tree.test.ts.
    bytes32 internal constant SHARED_FIXTURE_ROOT =
        0x4666c2deeb3c2765955201efa59ccfa4dcd3fcfff11eb56a973c7875382c9273;

    ProjectToken internal token;
    MerkleDistributor internal distributor;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");

    uint256 internal deadline;

    function setUp() public {
        vm.warp(1_800_000_000);
        deadline = block.timestamp + 90 days;

        token = new ProjectToken("Project", "PRJ", 1_000_000_000e18, 100_000_000e18, treasury, admin);
        distributor = new MerkleDistributor(IERC20(address(token)), SHARED_FIXTURE_ROOT, deadline, admin);

        vm.prank(treasury);
        token.transfer(address(distributor), 19_000e18);
    }

    function _amountFor(uint256 index) internal pure returns (uint256) {
        uint256[5] memory amounts = [uint256(1_000e18), 2_000e18, 3_000e18, 5_000e18, 8_000e18];
        return amounts[index];
    }

    function _accountFor(uint256 index) internal pure returns (address) {
        return address(uint160(index + 1));
    }

    function _leaf(uint256 index) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(index, _accountFor(index), _amountFor(index)))));
    }

    /// @dev Leaves in index order, matching the backend. Deliberately not sorted by hash.
    function _fixtureLeaves() internal pure returns (bytes32[] memory leaves) {
        leaves = new bytes32[](5);
        for (uint256 i; i < 5; ++i) {
            leaves[i] = _leaf(i);
        }
    }

    /// The core cross-check.
    function test_rootMatchesTypeScriptImplementation() public pure {
        assertEq(MerkleLib.getRoot(_fixtureLeaves()), SHARED_FIXTURE_ROOT, "roots diverged");
    }

    /// Every fixture entry claims successfully against the real contract.
    function test_everyFixtureEntryCanClaim() public {
        bytes32[] memory leaves = _fixtureLeaves();

        for (uint256 i; i < 5; ++i) {
            bytes32[] memory proof = MerkleLib.getProof(leaves, i);
            distributor.claim(i, _accountFor(i), _amountFor(i), proof);

            assertEq(token.balanceOf(_accountFor(i)), _amountFor(i), "claimant paid");
            assertTrue(distributor.isClaimed(i));
        }

        assertEq(token.balanceOf(address(distributor)), 0, "airdrop fully distributed");
        assertEq(distributor.totalClaimed(), 19_000e18);
    }

    /// A valid proof cannot be replayed under a different index to claim twice.
    function test_proofCannotBeReusedUnderAnotherIndex() public {
        bytes32[] memory leaves = _fixtureLeaves();
        bytes32[] memory proof = MerkleLib.getProof(leaves, 2);

        vm.expectRevert(MerkleDistributor.InvalidProof.selector);
        distributor.claim(4, _accountFor(2), _amountFor(2), proof);
    }
}
