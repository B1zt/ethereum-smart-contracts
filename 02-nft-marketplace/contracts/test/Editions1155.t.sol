// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Editions1155} from "../src/Editions1155.sol";
import {MerkleLib} from "./utils/MerkleLib.sol";

contract Editions1155Test is Test {
    Editions1155 internal editions;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal royaltyReceiver = makeAddr("royaltyReceiver");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint64 internal start;
    uint64 internal end;

    function setUp() public {
        vm.warp(1_800_000_000);
        start = uint64(block.timestamp + 1 hours);
        end = uint64(block.timestamp + 7 days);

        editions = new Editions1155("B1zt Editions", "BZTE", treasury, royaltyReceiver, 500, owner);

        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    function _openEdition(uint96 price, uint64 maxPerWallet, uint128 maxSupply)
        internal
        pure
        returns (Editions1155.Edition memory)
    {
        return Editions1155.Edition({
            merkleRoot: bytes32(0),
            price: price,
            startTime: 0,
            endTime: 0,
            maxSupply: maxSupply,
            maxPerWallet: maxPerWallet,
            exists: false
        });
    }

    function _create(uint256 id, uint96 price, uint64 maxPerWallet, uint128 maxSupply) internal {
        Editions1155.Edition memory e = _openEdition(price, maxPerWallet, maxSupply);
        e.startTime = start;
        e.endTime = end;

        vm.prank(owner);
        editions.createEdition(id, e, "ipfs://edition.json");
    }

    /*//////////////////////////////////////////////////////////////
                                CREATION
    //////////////////////////////////////////////////////////////*/

    function test_createEdition() public {
        _create(0, 0.1 ether, 5, 100);

        Editions1155.Edition memory e = editions.editions(0);
        assertEq(e.price, 0.1 ether);
        assertEq(e.maxSupply, 100);
        assertTrue(e.exists);
        assertEq(editions.uri(0), "ipfs://edition.json");
    }

    /// @dev Edition id 0 must be usable, which is why `exists` is an explicit flag rather than
    ///      inferring existence from a nonzero field.
    function test_editionIdZeroIsValid() public {
        _create(0, 0, 1, 10);
        vm.warp(start);

        vm.prank(alice);
        editions.mint(0, 1, 0, new bytes32[](0));

        assertEq(editions.balanceOf(alice, 0), 1);
    }

    function test_createEdition_revertsOnDuplicate() public {
        _create(1, 0, 1, 10);

        Editions1155.Edition memory e = _openEdition(0, 1, 10);
        e.startTime = start;
        e.endTime = end;

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Editions1155.EditionAlreadyExists.selector, 1));
        editions.createEdition(1, e, "x");
    }

    function test_createEdition_onlyOwner() public {
        Editions1155.Edition memory e = _openEdition(0, 1, 10);
        e.startTime = start;
        e.endTime = end;

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        editions.createEdition(1, e, "x");
    }

    function test_createEdition_rejectsUnboundedOpenEdition() public {
        Editions1155.Edition memory e = _openEdition(0, 0, 0);
        e.startTime = start;
        e.endTime = end;

        vm.prank(owner);
        vm.expectRevert(Editions1155.InvalidWindow.selector);
        editions.createEdition(1, e, "x");
    }

    /*//////////////////////////////////////////////////////////////
                                MINTING
    //////////////////////////////////////////////////////////////*/

    function test_mint_happyPath() public {
        _create(1, 0.1 ether, 5, 100);
        vm.warp(start);

        vm.prank(alice);
        editions.mint{value: 0.3 ether}(1, 3, 0, new bytes32[](0));

        assertEq(editions.balanceOf(alice, 1), 3);
        assertEq(editions.totalSupply(1), 3);
        assertEq(address(editions).balance, 0.3 ether);
    }

    function test_mint_enforcesSupplyCap() public {
        _create(1, 0, 100, 5);
        vm.warp(start);

        vm.prank(alice);
        editions.mint(1, 5, 0, new bytes32[](0));

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Editions1155.ExceedsEditionSupply.selector, 1, 0));
        editions.mint(1, 1, 0, new bytes32[](0));
    }

    function test_mint_enforcesWalletCap() public {
        _create(1, 0, 2, 100);
        vm.warp(start);

        vm.prank(alice);
        editions.mint(1, 2, 0, new bytes32[](0));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Editions1155.ExceedsWalletAllowance.selector, 1, 0));
        editions.mint(1, 1, 0, new bytes32[](0));
    }

    /// @dev An open edition with no supply cap is a legitimate configuration, bounded per wallet.
    function test_openEditionWithNoSupplyCap() public {
        _create(1, 0, 3, 0);
        vm.warp(start);

        for (uint256 i; i < 10; ++i) {
            address minter = address(uint160(0x9000 + i));
            vm.prank(minter);
            editions.mint(1, 3, 0, new bytes32[](0));
        }

        assertEq(editions.totalSupply(1), 30);
    }

    function test_mint_revertsOutsideWindow() public {
        _create(1, 0, 5, 100);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Editions1155.EditionNotActive.selector, 1));
        editions.mint(1, 1, 0, new bytes32[](0));

        vm.warp(end);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Editions1155.EditionNotActive.selector, 1));
        editions.mint(1, 1, 0, new bytes32[](0));
    }

    function test_mint_requiresExactPayment() public {
        _create(1, 0.1 ether, 5, 100);
        vm.warp(start);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Editions1155.IncorrectPayment.selector, 0.25 ether, 0.2 ether));
        editions.mint{value: 0.25 ether}(1, 2, 0, new bytes32[](0));
    }

    function test_mint_allowlist() public {
        bytes32[] memory leaves = new bytes32[](3);
        leaves[0] = keccak256(bytes.concat(keccak256(abi.encode(alice, uint256(2)))));
        leaves[1] = keccak256(bytes.concat(keccak256(abi.encode(bob, uint256(1)))));
        leaves[2] = keccak256(bytes.concat(keccak256(abi.encode(address(0xdead), uint256(9)))));

        Editions1155.Edition memory e = _openEdition(0, 0, 100);
        e.startTime = start;
        e.endTime = end;
        e.merkleRoot = MerkleLib.getRoot(leaves);

        vm.prank(owner);
        editions.createEdition(1, e, "ipfs://gated.json");

        vm.warp(start);

        bytes32[] memory aliceProof = MerkleLib.getProof(leaves, 0);
        vm.prank(alice);
        editions.mint(1, 2, 2, aliceProof);
        assertEq(editions.balanceOf(alice, 1), 2);

        // Bob cannot use Alice's allowance.
        vm.prank(bob);
        vm.expectRevert(Editions1155.InvalidProof.selector);
        editions.mint(1, 2, 2, aliceProof);
    }

    function test_ownerMint_airdrops() public {
        _create(1, 0, 1, 100);

        address[] memory recipients = new address[](2);
        recipients[0] = alice;
        recipients[1] = bob;

        uint256[] memory quantities = new uint256[](2);
        quantities[0] = 3;
        quantities[1] = 7;

        vm.prank(owner);
        editions.ownerMint(recipients, 1, quantities);

        assertEq(editions.balanceOf(alice, 1), 3);
        assertEq(editions.balanceOf(bob, 1), 7);
    }

    function test_ownerMint_revertsOnLengthMismatch() public {
        _create(1, 0, 1, 100);

        address[] memory recipients = new address[](2);
        uint256[] memory quantities = new uint256[](1);

        vm.prank(owner);
        vm.expectRevert(Editions1155.LengthMismatch.selector);
        editions.ownerMint(recipients, 1, quantities);
    }

    /*//////////////////////////////////////////////////////////////
                                METADATA
    //////////////////////////////////////////////////////////////*/

    function test_setEditionURI() public {
        _create(1, 0, 1, 10);

        vm.prank(owner);
        editions.setEditionURI(1, "ipfs://updated.json");

        assertEq(editions.uri(1), "ipfs://updated.json");
    }

    function test_freezeMetadata_isPermanent() public {
        _create(1, 0, 1, 10);

        vm.prank(owner);
        editions.freezeMetadata(1);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Editions1155.MetadataFrozen.selector, 1));
        editions.setEditionURI(1, "ipfs://rug.json");
    }

    function test_uri_revertsForUnknownEdition() public {
        vm.expectRevert(abi.encodeWithSelector(Editions1155.EditionDoesNotExist.selector, 42));
        editions.uri(42);
    }

    /*//////////////////////////////////////////////////////////////
                          UPDATES AND ROYALTIES
    //////////////////////////////////////////////////////////////*/

    /// @dev Lowering `maxSupply` below what is already minted would make total supply exceed the
    ///      cap, so it must be rejected.
    function test_updateEdition_cannotDropSupplyBelowMinted() public {
        _create(1, 0, 100, 100);
        vm.warp(start);

        vm.prank(alice);
        editions.mint(1, 10, 0, new bytes32[](0));

        Editions1155.Edition memory e = _openEdition(0, 100, 5);
        e.startTime = start;
        e.endTime = end;

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Editions1155.ExceedsEditionSupply.selector, 10, 5));
        editions.updateEdition(1, e);
    }

    function test_perEditionRoyaltyOverride() public {
        _create(1, 0, 1, 10);

        vm.prank(owner);
        editions.setTokenRoyalty(1, alice, 800);

        (address receiver, uint256 amount) = editions.royaltyInfo(1, 10_000);
        assertEq(receiver, alice);
        assertEq(amount, 800);

        // Other editions still use the default.
        (address defaultReceiver, uint256 defaultAmount) = editions.royaltyInfo(2, 10_000);
        assertEq(defaultReceiver, royaltyReceiver);
        assertEq(defaultAmount, 500);
    }

    function test_royaltyCapIsEnforced() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Editions1155.RoyaltyTooHigh.selector, uint96(1_500)));
        editions.setDefaultRoyalty(alice, 1_500);
    }

    function test_supportsInterface() public view {
        assertTrue(editions.supportsInterface(0xd9b67a26)); // ERC1155
        assertTrue(editions.supportsInterface(type(IERC2981).interfaceId));
        assertFalse(editions.supportsInterface(0xdeadbeef));
    }

    function test_withdraw() public {
        _create(1, 1 ether, 5, 100);
        vm.warp(start);

        vm.prank(alice);
        editions.mint{value: 2 ether}(1, 2, 0, new bytes32[](0));

        editions.withdraw();
        assertEq(treasury.balance, 2 ether);
    }

    /*//////////////////////////////////////////////////////////////
                                 FUZZ
    //////////////////////////////////////////////////////////////*/

    function testFuzz_supplyNeverExceedsCap(uint8[8] calldata quantities) public {
        uint128 cap = 20;
        _create(1, 0, type(uint64).max, cap);
        vm.warp(start);

        for (uint256 i; i < quantities.length; ++i) {
            uint256 quantity = bound(quantities[i], 1, 10);
            address minter = address(uint160(0xA000 + i));

            vm.prank(minter);
            try editions.mint(1, quantity, 0, new bytes32[](0)) {} catch {}

            assertLe(editions.totalSupply(1), cap);
        }
    }
}
