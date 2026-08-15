// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Collection721} from "../src/Collection721.sol";
import {MerkleLib} from "./utils/MerkleLib.sol";
import {RejectingReceiver} from "./utils/Mocks.sol";

contract Collection721Test is Test {
    Collection721 internal collection;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal royaltyReceiver = makeAddr("royaltyReceiver");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint256 internal constant MAX_SUPPLY = 1_000;
    uint96 internal constant ROYALTY_BPS = 500;
    string internal constant UNREVEALED_URI = "ipfs://placeholder.json";

    uint64 internal start;
    uint64 internal end;

    function setUp() public {
        // Start at a realistic timestamp so `startTime` values are never in the past by accident.
        vm.warp(1_800_000_000);
        start = uint64(block.timestamp + 1 hours);
        end = uint64(block.timestamp + 2 days);

        collection = new Collection721(
            "B1zt Genesis", "BZTG", MAX_SUPPLY, UNREVEALED_URI, treasury, royaltyReceiver, ROYALTY_BPS, owner
        );

        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _publicPhase(uint96 price, uint16 maxPerWallet) internal view returns (Collection721.Phase memory) {
        return Collection721.Phase({
            merkleRoot: bytes32(0),
            price: price,
            startTime: start,
            endTime: end,
            maxPerWallet: maxPerWallet,
            maxSupply: 0
        });
    }

    /// @dev Leaf encoding must match the contract exactly: double-hashed abi.encode(account, allowance).
    function _leaf(address account, uint256 allowance) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account, allowance))));
    }

    function _allowlist() internal view returns (bytes32[] memory leaves) {
        leaves = new bytes32[](4);
        leaves[0] = _leaf(alice, 3);
        leaves[1] = _leaf(bob, 1);
        leaves[2] = _leaf(carol, 5);
        leaves[3] = _leaf(address(0xdead), 2);
    }

    function _addPublicPhase(uint96 price, uint16 maxPerWallet) internal returns (uint256 phaseId) {
        vm.prank(owner);
        return collection.addPhase(_publicPhase(price, maxPerWallet));
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    function test_constructor_setsInitialState() public view {
        assertEq(collection.name(), "B1zt Genesis");
        assertEq(collection.symbol(), "BZTG");
        assertEq(collection.maxSupply(), MAX_SUPPLY);
        assertEq(collection.owner(), owner);
        assertEq(collection.treasury(), treasury);
        assertFalse(collection.revealed());

        (address receiver, uint256 amount) = collection.royaltyInfo(1, 10_000);
        assertEq(receiver, royaltyReceiver);
        assertEq(amount, 500);
    }

    function test_constructor_revertsOnExcessiveRoyalty() public {
        vm.expectRevert(abi.encodeWithSelector(Collection721.RoyaltyTooHigh.selector, uint96(1_001)));
        new Collection721("X", "X", 10, "", treasury, royaltyReceiver, 1_001, owner);
    }

    function test_tokenIdsStartAtOne() public {
        uint256 phaseId = _addPublicPhase(0.1 ether, 5);
        vm.warp(start);

        vm.prank(alice);
        collection.mint{value: 0.1 ether}(phaseId, 1, 0, new bytes32[](0));

        assertEq(collection.ownerOf(1), alice);
    }

    /*//////////////////////////////////////////////////////////////
                             PUBLIC MINTING
    //////////////////////////////////////////////////////////////*/

    function test_publicMint_happyPath() public {
        uint256 phaseId = _addPublicPhase(0.1 ether, 5);
        vm.warp(start);

        vm.prank(alice);
        collection.mint{value: 0.3 ether}(phaseId, 3, 0, new bytes32[](0));

        assertEq(collection.balanceOf(alice), 3);
        assertEq(collection.totalMinted(), 3);
        assertEq(collection.walletMinted(phaseId, alice), 3);
        assertEq(collection.phaseMinted(phaseId), 3);
        assertEq(address(collection).balance, 0.3 ether);
    }

    function test_publicMint_revertsBeforeStart() public {
        uint256 phaseId = _addPublicPhase(0.1 ether, 5);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Collection721.PhaseNotActive.selector, phaseId));
        collection.mint{value: 0.1 ether}(phaseId, 1, 0, new bytes32[](0));
    }

    function test_publicMint_revertsAfterEnd() public {
        uint256 phaseId = _addPublicPhase(0.1 ether, 5);
        vm.warp(end);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Collection721.PhaseNotActive.selector, phaseId));
        collection.mint{value: 0.1 ether}(phaseId, 1, 0, new bytes32[](0));
    }

    function test_publicMint_revertsOnWrongPayment() public {
        uint256 phaseId = _addPublicPhase(0.1 ether, 5);
        vm.warp(start);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Collection721.IncorrectPayment.selector, 0.2 ether, 0.3 ether));
        collection.mint{value: 0.2 ether}(phaseId, 3, 0, new bytes32[](0));

        // Overpaying is rejected too. Silent acceptance would quietly take a buyer's extra ETH.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Collection721.IncorrectPayment.selector, 0.4 ether, 0.3 ether));
        collection.mint{value: 0.4 ether}(phaseId, 3, 0, new bytes32[](0));
    }

    function test_publicMint_enforcesPerWalletCap() public {
        uint256 phaseId = _addPublicPhase(0.1 ether, 2);
        vm.warp(start);

        vm.prank(alice);
        collection.mint{value: 0.2 ether}(phaseId, 2, 0, new bytes32[](0));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Collection721.ExceedsWalletAllowance.selector, 1, 0));
        collection.mint{value: 0.1 ether}(phaseId, 1, 0, new bytes32[](0));

        // The cap is per wallet, so another buyer is unaffected.
        vm.prank(bob);
        collection.mint{value: 0.2 ether}(phaseId, 2, 0, new bytes32[](0));
        assertEq(collection.balanceOf(bob), 2);
    }

    function test_publicMint_rejectsProof() public {
        uint256 phaseId = _addPublicPhase(0.1 ether, 5);
        vm.warp(start);

        bytes32[] memory proof = new bytes32[](1);
        proof[0] = bytes32(uint256(1));

        vm.prank(alice);
        vm.expectRevert(Collection721.ProofNotRequired.selector);
        collection.mint{value: 0.1 ether}(phaseId, 1, 0, proof);
    }

    function test_publicMint_revertsOnZeroQuantity() public {
        uint256 phaseId = _addPublicPhase(0.1 ether, 5);
        vm.warp(start);

        vm.prank(alice);
        vm.expectRevert(Collection721.ZeroQuantity.selector);
        collection.mint(phaseId, 0, 0, new bytes32[](0));
    }

    function test_freeMintIsSupported() public {
        uint256 phaseId = _addPublicPhase(0, 2);
        vm.warp(start);

        vm.prank(alice);
        collection.mint(phaseId, 2, 0, new bytes32[](0));

        assertEq(collection.balanceOf(alice), 2);
    }

    /*//////////////////////////////////////////////////////////////
                           ALLOWLIST MINTING
    //////////////////////////////////////////////////////////////*/

    function test_allowlistMint_happyPath() public {
        bytes32[] memory leaves = _allowlist();
        bytes32 root = MerkleLib.getRoot(leaves);

        vm.prank(owner);
        uint256 phaseId = collection.addPhase(
            Collection721.Phase({
                merkleRoot: root,
                price: 0.05 ether,
                startTime: start,
                endTime: end,
                maxPerWallet: 0,
                maxSupply: 0
            })
        );

        vm.warp(start);
        bytes32[] memory proof = MerkleLib.getProof(leaves, 0);

        vm.prank(alice);
        collection.mint{value: 0.15 ether}(phaseId, 3, 3, proof);

        assertEq(collection.balanceOf(alice), 3);
    }

    function test_allowlistMint_enforcesPerAddressAllowance() public {
        bytes32[] memory leaves = _allowlist();
        bytes32 root = MerkleLib.getRoot(leaves);

        vm.prank(owner);
        uint256 phaseId = collection.addPhase(
            Collection721.Phase({
                merkleRoot: root,
                price: 0,
                startTime: start,
                endTime: end,
                maxPerWallet: 0,
                maxSupply: 0
            })
        );

        vm.warp(start);

        // Bob's leaf allows exactly 1.
        bytes32[] memory bobProof = MerkleLib.getProof(leaves, 1);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Collection721.ExceedsWalletAllowance.selector, 2, 1));
        collection.mint(phaseId, 2, 1, bobProof);

        vm.prank(bob);
        collection.mint(phaseId, 1, 1, bobProof);
        assertEq(collection.balanceOf(bob), 1);
    }

    function test_allowlistMint_rejectsInflatedAllowance() public {
        bytes32[] memory leaves = _allowlist();
        bytes32 root = MerkleLib.getRoot(leaves);

        vm.prank(owner);
        uint256 phaseId = collection.addPhase(
            Collection721.Phase({
                merkleRoot: root,
                price: 0,
                startTime: start,
                endTime: end,
                maxPerWallet: 0,
                maxSupply: 0
            })
        );

        vm.warp(start);
        bytes32[] memory proof = MerkleLib.getProof(leaves, 1);

        // Bob presents his real proof but claims a bigger allowance. The leaf no longer matches.
        vm.prank(bob);
        vm.expectRevert(Collection721.InvalidProof.selector);
        collection.mint(phaseId, 100, 100, proof);
    }

    function test_allowlistMint_rejectsNonMember() public {
        bytes32[] memory leaves = _allowlist();
        bytes32 root = MerkleLib.getRoot(leaves);

        vm.prank(owner);
        uint256 phaseId = collection.addPhase(
            Collection721.Phase({
                merkleRoot: root,
                price: 0,
                startTime: start,
                endTime: end,
                maxPerWallet: 0,
                maxSupply: 0
            })
        );

        vm.warp(start);
        bytes32[] memory aliceProof = MerkleLib.getProof(leaves, 0);

        address mallory = makeAddr("mallory");
        vm.prank(mallory);
        vm.expectRevert(Collection721.InvalidProof.selector);
        collection.mint(phaseId, 1, 3, aliceProof);
    }

    function test_allowlistMint_proofIsNotTransferable() public {
        bytes32[] memory leaves = _allowlist();
        bytes32 root = MerkleLib.getRoot(leaves);

        vm.prank(owner);
        uint256 phaseId = collection.addPhase(
            Collection721.Phase({
                merkleRoot: root,
                price: 0,
                startTime: start,
                endTime: end,
                maxPerWallet: 0,
                maxSupply: 0
            })
        );

        vm.warp(start);
        // Carol's proof, presented by Alice. The leaf binds to msg.sender, so it fails.
        bytes32[] memory carolProof = MerkleLib.getProof(leaves, 2);

        vm.prank(alice);
        vm.expectRevert(Collection721.InvalidProof.selector);
        collection.mint(phaseId, 5, 5, carolProof);
    }

    /*//////////////////////////////////////////////////////////////
                                 CAPS
    //////////////////////////////////////////////////////////////*/

    function test_phaseSupplyCapIsEnforced() public {
        vm.prank(owner);
        uint256 phaseId = collection.addPhase(
            Collection721.Phase({
                merkleRoot: bytes32(0),
                price: 0,
                startTime: start,
                endTime: end,
                maxPerWallet: 100,
                maxSupply: 5
            })
        );

        vm.warp(start);

        vm.prank(alice);
        collection.mint(phaseId, 5, 0, new bytes32[](0));

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Collection721.ExceedsPhaseSupply.selector, 1, 0));
        collection.mint(phaseId, 1, 0, new bytes32[](0));
    }

    function test_globalSupplyCapIsEnforced() public {
        Collection721 small = new Collection721("S", "S", 3, "", treasury, royaltyReceiver, 0, owner);

        vm.prank(owner);
        uint256 phaseId = small.addPhase(_publicPhase(0, 100));

        vm.warp(start);

        vm.prank(alice);
        small.mint(phaseId, 3, 0, new bytes32[](0));

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Collection721.ExceedsMaxSupply.selector, 1, 0));
        small.mint(phaseId, 1, 0, new bytes32[](0));

        assertEq(small.remainingSupply(), 0);
    }

    function test_ownerMintRespectsGlobalCap() public {
        Collection721 small = new Collection721("S", "S", 3, "", treasury, royaltyReceiver, 0, owner);

        vm.prank(owner);
        small.ownerMint(alice, 3);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Collection721.ExceedsMaxSupply.selector, 1, 0));
        small.ownerMint(alice, 1);
    }

    function test_ownerMint_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        collection.ownerMint(alice, 1);
    }

    /*//////////////////////////////////////////////////////////////
                          PHASE ADMINISTRATION
    //////////////////////////////////////////////////////////////*/

    function test_addPhase_rejectsInvertedWindow() public {
        vm.prank(owner);
        vm.expectRevert(Collection721.InvalidPhaseWindow.selector);
        collection.addPhase(
            Collection721.Phase({
                merkleRoot: bytes32(0),
                price: 0,
                startTime: end,
                endTime: start,
                maxPerWallet: 1,
                maxSupply: 0
            })
        );
    }

    function test_addPhase_rejectsUncappedPublicPhase() public {
        vm.prank(owner);
        vm.expectRevert(Collection721.InvalidPhaseWindow.selector);
        collection.addPhase(_publicPhase(0, 0));
    }

    function test_editingPhaseDoesNotResetWalletCounters() public {
        uint256 phaseId = _addPublicPhase(0, 2);
        vm.warp(start);

        vm.prank(alice);
        collection.mint(phaseId, 2, 0, new bytes32[](0));

        // Owner rewrites the phase. Alice's minted count must survive, otherwise the owner could
        // hand out unlimited extra allocation just by touching the config.
        vm.prank(owner);
        collection.setPhase(phaseId, _publicPhase(0, 2));

        assertEq(collection.walletMinted(phaseId, alice), 2);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Collection721.ExceedsWalletAllowance.selector, 1, 0));
        collection.mint(phaseId, 1, 0, new bytes32[](0));
    }

    function test_popPhase() public {
        _addPublicPhase(0, 1);
        assertEq(collection.phaseCount(), 1);

        vm.prank(owner);
        collection.popPhase();
        assertEq(collection.phaseCount(), 0);
    }

    function test_mint_revertsOnUnknownPhase() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Collection721.PhaseDoesNotExist.selector, 7));
        collection.mint(7, 1, 0, new bytes32[](0));
    }

    /*//////////////////////////////////////////////////////////////
                          METADATA AND REVEAL
    //////////////////////////////////////////////////////////////*/

    function test_tokenURI_placeholderBeforeReveal() public {
        uint256 phaseId = _addPublicPhase(0, 2);
        vm.warp(start);

        vm.prank(alice);
        collection.mint(phaseId, 2, 0, new bytes32[](0));

        assertEq(collection.tokenURI(1), UNREVEALED_URI);
        assertEq(collection.tokenURI(2), UNREVEALED_URI);
    }

    function test_reveal_switchesToRealMetadata() public {
        uint256 phaseId = _addPublicPhase(0, 2);
        vm.warp(start);

        vm.prank(alice);
        collection.mint(phaseId, 1, 0, new bytes32[](0));

        vm.prank(owner);
        collection.reveal("ipfs://QmReal/");

        assertTrue(collection.revealed());
        assertEq(collection.tokenURI(1), "ipfs://QmReal/1.json");
    }

    function test_reveal_isOneWay() public {
        vm.startPrank(owner);
        collection.reveal("ipfs://a/");

        vm.expectRevert(Collection721.AlreadyRevealed.selector);
        collection.reveal("ipfs://b/");

        vm.expectRevert(Collection721.AlreadyRevealed.selector);
        collection.setUnrevealedURI("ipfs://c");
        vm.stopPrank();
    }

    function test_provenanceHash_locksAfterFirstWrite() public {
        bytes32 hash = keccak256("the canonical image order");

        vm.prank(owner);
        collection.setProvenanceHash(hash);
        assertEq(collection.provenanceHash(), hash);

        vm.prank(owner);
        vm.expectRevert(Collection721.ProvenanceAlreadyLocked.selector);
        collection.setProvenanceHash(keccak256("a different order"));
    }

    function test_tokenURI_revertsForNonexistentToken() public {
        vm.expectRevert();
        collection.tokenURI(999);
    }

    /*//////////////////////////////////////////////////////////////
                          ROYALTIES AND FUNDS
    //////////////////////////////////////////////////////////////*/

    function test_supportsInterface() public view {
        assertTrue(collection.supportsInterface(0x80ac58cd)); // ERC721
        assertTrue(collection.supportsInterface(0x5b5e139f)); // ERC721Metadata
        assertTrue(collection.supportsInterface(type(IERC2981).interfaceId));
        assertTrue(collection.supportsInterface(0x01ffc9a7)); // ERC165
        assertFalse(collection.supportsInterface(0xdeadbeef));
    }

    function test_setDefaultRoyalty_respectsCap() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Collection721.RoyaltyTooHigh.selector, uint96(2_000)));
        collection.setDefaultRoyalty(royaltyReceiver, 2_000);

        vm.prank(owner);
        collection.setDefaultRoyalty(alice, 1_000);

        (address receiver, uint256 amount) = collection.royaltyInfo(1, 10_000);
        assertEq(receiver, alice);
        assertEq(amount, 1_000);
    }

    function test_withdraw_sendsEverythingToTreasury() public {
        uint256 phaseId = _addPublicPhase(1 ether, 5);
        vm.warp(start);

        vm.prank(alice);
        collection.mint{value: 3 ether}(phaseId, 3, 0, new bytes32[](0));

        // Permissionless by design: the destination is fixed by the owner, so anyone may push it.
        vm.prank(carol);
        collection.withdraw();

        assertEq(treasury.balance, 3 ether);
        assertEq(address(collection).balance, 0);
    }

    function test_withdraw_revertsWhenEmpty() public {
        vm.expectRevert(Collection721.NothingToWithdraw.selector);
        collection.withdraw();
    }

    function test_withdraw_revertsIfTreasuryRejectsETH() public {
        RejectingReceiver rejector = new RejectingReceiver();

        vm.prank(owner);
        collection.setTreasury(address(rejector));

        uint256 phaseId = _addPublicPhase(1 ether, 5);
        vm.warp(start);

        vm.prank(alice);
        collection.mint{value: 1 ether}(phaseId, 1, 0, new bytes32[](0));

        vm.expectRevert(Collection721.WithdrawFailed.selector);
        collection.withdraw();
    }

    /*//////////////////////////////////////////////////////////////
                                 FUZZ
    //////////////////////////////////////////////////////////////*/

    /// @dev Payment must be exact for any quantity and price the phase can express.
    function testFuzz_paymentMustBeExact(uint96 price, uint8 quantity, uint256 sent) public {
        quantity = uint8(bound(quantity, 1, 20));
        price = uint96(bound(price, 0, 10 ether));

        uint256 expected = uint256(price) * quantity;
        sent = bound(sent, 0, 100 ether);
        vm.assume(sent != expected);

        uint256 phaseId = _addPublicPhase(price, 20);
        vm.warp(start);

        vm.deal(alice, 200 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Collection721.IncorrectPayment.selector, sent, expected));
        collection.mint{value: sent}(phaseId, quantity, 0, new bytes32[](0));
    }

    /// @dev No sequence of mints can push supply past the cap.
    function testFuzz_supplyNeverExceedsCap(uint8[10] calldata quantities) public {
        Collection721 small = new Collection721("S", "S", 25, "", treasury, royaltyReceiver, 0, owner);

        vm.prank(owner);
        uint256 phaseId = small.addPhase(_publicPhase(0, type(uint16).max));
        vm.warp(start);

        for (uint256 i; i < quantities.length; ++i) {
            uint256 quantity = bound(quantities[i], 1, 10);
            address minter = address(uint160(0x1000 + i));

            vm.prank(minter);
            try small.mint(phaseId, quantity, 0, new bytes32[](0)) {} catch {}

            assertLe(small.totalMinted(), 25);
        }
    }

    /// @dev Contract balance always equals the sum of what was paid in, until withdrawn.
    function testFuzz_balanceTracksPayments(uint8 mintCount, uint96 price) public {
        mintCount = uint8(bound(mintCount, 1, 10));
        price = uint96(bound(price, 1, 1 ether));

        uint256 phaseId = _addPublicPhase(price, type(uint16).max);
        vm.warp(start);

        uint256 expected;
        for (uint256 i; i < mintCount; ++i) {
            address minter = address(uint160(0x2000 + i));
            vm.deal(minter, 100 ether);

            vm.prank(minter);
            collection.mint{value: price}(phaseId, 1, 0, new bytes32[](0));
            expected += price;
        }

        assertEq(address(collection).balance, expected);
    }
}
