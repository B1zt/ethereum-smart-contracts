// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Collection721} from "../src/Collection721.sol";
import {MerkleLib} from "./utils/MerkleLib.sol";

/// @notice Proves the Solidity and TypeScript Merkle implementations agree.
///
/// @dev The allowlist tree is built off-chain by the backend and verified on-chain by the mint
///      function. Nothing forces the two to agree, and when they disagree the failure is silent
///      and total: the API serves well-formed proofs, and every mint reverts with `InvalidProof`.
///
///      Both sides build a tree from the same fixed entry set and assert the same root constant.
///      The TypeScript twin lives in `backend/src/merkle/tree.test.ts`. If either implementation
///      changes its leaf encoding, pair ordering or odd-node handling, one of the two tests breaks.
contract MerkleCrossCheckTest is Test {
    /// @dev Must match SHARED_FIXTURE_ROOT in backend/src/merkle/tree.test.ts.
    bytes32 internal constant SHARED_FIXTURE_ROOT =
        0x84790ae8790a0e497b9d0df18feea9350eb8349d15929ca25f3a780545111096;

    address internal constant ADDR_1 = address(1);
    address internal constant ADDR_2 = address(2);
    address internal constant ADDR_3 = address(3);
    address internal constant ADDR_4 = address(4);
    address internal constant ADDR_5 = address(5);

    Collection721 internal collection;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        vm.warp(1_800_000_000);
        collection = new Collection721("X", "X", 1_000, "", treasury, treasury, 0, owner);
    }

    /// @dev Leaves must come out already sorted, which is what the backend does before building.
    function _fixtureLeaves() internal pure returns (bytes32[] memory leaves) {
        bytes32[] memory unsorted = new bytes32[](5);
        unsorted[0] = _leaf(ADDR_1, 1);
        unsorted[1] = _leaf(ADDR_2, 2);
        unsorted[2] = _leaf(ADDR_3, 3);
        unsorted[3] = _leaf(ADDR_4, 5);
        unsorted[4] = _leaf(ADDR_5, 8);

        // Insertion sort. Five elements, and a library sort for bytes32 is not worth pulling in.
        for (uint256 i = 1; i < unsorted.length; ++i) {
            bytes32 key = unsorted[i];
            uint256 j = i;
            while (j > 0 && unsorted[j - 1] > key) {
                unsorted[j] = unsorted[j - 1];
                --j;
            }
            unsorted[j] = key;
        }

        return unsorted;
    }

    function _leaf(address account, uint256 allowance) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account, allowance))));
    }

    /// @dev Position of an address's leaf in the sorted array.
    function _indexOf(bytes32[] memory leaves, bytes32 target) internal pure returns (uint256) {
        for (uint256 i; i < leaves.length; ++i) {
            if (leaves[i] == target) return i;
        }
        revert("leaf not found");
    }

    /// The core cross-check: same entries, same root, on both sides of the stack.
    function test_rootMatchesTypeScriptImplementation() public pure {
        assertEq(MerkleLib.getRoot(_fixtureLeaves()), SHARED_FIXTURE_ROOT, "roots diverged");
    }

    /// A proof built from the shared fixture is accepted by the real mint path.
    function test_fixtureProofIsAcceptedByTheContract() public {
        bytes32[] memory leaves = _fixtureLeaves();

        vm.prank(owner);
        uint256 phaseId = collection.addPhase(
            Collection721.Phase({
                merkleRoot: SHARED_FIXTURE_ROOT,
                price: 0,
                startTime: uint64(block.timestamp),
                endTime: uint64(block.timestamp + 1 days),
                maxPerWallet: 0,
                maxSupply: 0
            })
        );

        uint256 index = _indexOf(leaves, _leaf(ADDR_4, 5));
        bytes32[] memory proof = MerkleLib.getProof(leaves, index);

        vm.prank(ADDR_4);
        collection.mint(phaseId, 5, 5, proof);

        assertEq(collection.balanceOf(ADDR_4), 5);
    }

    /// Every fixture entry can mint exactly its allowance and no more.
    function test_everyFixtureEntryCanMintItsAllowance() public {
        bytes32[] memory leaves = _fixtureLeaves();

        vm.prank(owner);
        uint256 phaseId = collection.addPhase(
            Collection721.Phase({
                merkleRoot: SHARED_FIXTURE_ROOT,
                price: 0,
                startTime: uint64(block.timestamp),
                endTime: uint64(block.timestamp + 1 days),
                maxPerWallet: 0,
                maxSupply: 0
            })
        );

        address[5] memory accounts = [ADDR_1, ADDR_2, ADDR_3, ADDR_4, ADDR_5];
        uint256[5] memory allowances = [uint256(1), 2, 3, 5, 8];

        for (uint256 i; i < accounts.length; ++i) {
            uint256 index = _indexOf(leaves, _leaf(accounts[i], allowances[i]));
            bytes32[] memory proof = MerkleLib.getProof(leaves, index);

            vm.prank(accounts[i]);
            collection.mint(phaseId, allowances[i], allowances[i], proof);
            assertEq(collection.balanceOf(accounts[i]), allowances[i]);

            // One more than the allowance must fail.
            vm.prank(accounts[i]);
            vm.expectRevert(
                abi.encodeWithSelector(Collection721.ExceedsWalletAllowance.selector, 1, 0)
            );
            collection.mint(phaseId, 1, allowances[i], proof);
        }
    }
}
