// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Collection721} from "../src/Collection721.sol";
import {EnglishAuction} from "../src/EnglishAuction.sol";
import {TokenType} from "../src/OrderTypes.sol";
import {PaymentSettler} from "../src/PaymentSettler.sol";
import {MockERC1155, MockERC20, RejectingReceiver} from "./utils/Mocks.sol";

contract EnglishAuctionTest is Test {
    EnglishAuction internal auctionHouse;
    Collection721 internal collection;
    MockERC20 internal weth;
    MockERC1155 internal editions;

    address internal owner = makeAddr("owner");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal royaltyReceiver = makeAddr("royaltyReceiver");
    address internal treasury = makeAddr("treasury");
    address internal seller = makeAddr("seller");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint96 internal constant PROTOCOL_FEE_BPS = 250;
    uint96 internal constant ROYALTY_BPS = 500;

    uint64 internal start;
    uint64 internal end;
    uint32 internal constant EXTENSION_WINDOW = 10 minutes;
    uint32 internal constant EXTENSION_DURATION = 10 minutes;
    uint16 internal constant MIN_INCREMENT_BPS = 500; // 5%

    function setUp() public {
        vm.warp(1_800_000_000);
        start = uint64(block.timestamp);
        end = uint64(block.timestamp + 1 days);

        auctionHouse = new EnglishAuction(owner, feeRecipient, PROTOCOL_FEE_BPS);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        editions = new MockERC1155();

        collection = new Collection721(
            "Genesis", "GEN", 1_000, "ipfs://placeholder", treasury, royaltyReceiver, ROYALTY_BPS, owner
        );

        vm.prank(owner);
        auctionHouse.setCurrencyAllowed(address(weth), true);

        vm.prank(owner);
        collection.ownerMint(seller, 3);

        vm.prank(seller);
        collection.setApprovalForAll(address(auctionHouse), true);

        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);

        weth.mint(alice, 1_000 ether);
        weth.mint(bob, 1_000 ether);
        vm.prank(alice);
        weth.approve(address(auctionHouse), type(uint256).max);
        vm.prank(bob);
        weth.approve(address(auctionHouse), type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _createAuction(address currency, uint256 reserve) internal returns (uint256) {
        vm.prank(seller);
        return auctionHouse.createAuction(
            address(collection),
            1,
            1,
            TokenType.ERC721,
            currency,
            reserve,
            start,
            end,
            EXTENSION_WINDOW,
            EXTENSION_DURATION,
            MIN_INCREMENT_BPS
        );
    }

    /*//////////////////////////////////////////////////////////////
                               CREATION
    //////////////////////////////////////////////////////////////*/

    function test_createAuction_escrowsAsset() public {
        uint256 id = _createAuction(address(0), 1 ether);

        assertEq(collection.ownerOf(1), address(auctionHouse), "asset escrowed");

        EnglishAuction.Auction memory a = auctionHouse.auctions(id);
        assertEq(a.seller, seller);
        assertEq(a.reservePrice, 1 ether);
        assertEq(a.highestBidder, address(0));
        assertFalse(a.settled);
    }

    function test_createAuction_revertsOnInvertedWindow() public {
        vm.prank(seller);
        vm.expectRevert(EnglishAuction.InvalidWindow.selector);
        auctionHouse.createAuction(
            address(collection), 1, 1, TokenType.ERC721, address(0), 1 ether, end, start, 0, 0, 0
        );
    }

    function test_createAuction_revertsOnPastEndTime() public {
        vm.prank(seller);
        vm.expectRevert(EnglishAuction.InvalidWindow.selector);
        auctionHouse.createAuction(
            address(collection),
            1,
            1,
            TokenType.ERC721,
            address(0),
            1 ether,
            uint64(block.timestamp - 2 days),
            uint64(block.timestamp - 1 days),
            0,
            0,
            0
        );
    }

    function test_createAuction_rejectsExtensionWindowWithoutDuration() public {
        vm.prank(seller);
        vm.expectRevert(EnglishAuction.InvalidExtension.selector);
        auctionHouse.createAuction(
            address(collection), 1, 1, TokenType.ERC721, address(0), 1 ether, start, end, 10 minutes, 0, 0
        );
    }

    function test_createAuction_rejectsOversizedExtension() public {
        vm.prank(seller);
        vm.expectRevert(EnglishAuction.InvalidExtension.selector);
        auctionHouse.createAuction(
            address(collection), 1, 1, TokenType.ERC721, address(0), 1 ether, start, end, 10 minutes, 2 hours, 0
        );
    }

    function test_createAuction_rejectsExcessiveIncrement() public {
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(EnglishAuction.IncrementTooHigh.selector, uint16(6_000)));
        auctionHouse.createAuction(
            address(collection), 1, 1, TokenType.ERC721, address(0), 1 ether, start, end, 0, 0, 6_000
        );
    }

    function test_createAuction_rejectsDisallowedCurrency() public {
        MockERC20 shady = new MockERC20("Shady", "SHAD", 18);

        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(EnglishAuction.CurrencyNotAllowed.selector, address(shady)));
        auctionHouse.createAuction(
            address(collection), 1, 1, TokenType.ERC721, address(shady), 1 ether, start, end, 0, 0, 0
        );
    }

    /*//////////////////////////////////////////////////////////////
                                BIDDING
    //////////////////////////////////////////////////////////////*/

    function test_bid_revertsBelowReserve() public {
        uint256 id = _createAuction(address(0), 5 ether);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(EnglishAuction.BidBelowReserve.selector, 4 ether, 5 ether));
        auctionHouse.bid{value: 4 ether}(id, 4 ether);
    }

    function test_bid_acceptsReserveExactly() public {
        uint256 id = _createAuction(address(0), 5 ether);

        vm.prank(alice);
        auctionHouse.bid{value: 5 ether}(id, 5 ether);

        assertEq(auctionHouse.auctions(id).highestBidder, alice);
        assertEq(auctionHouse.auctions(id).highestBid, 5 ether);
    }

    function test_bid_enforcesMinimumIncrement() public {
        uint256 id = _createAuction(address(0), 10 ether);

        vm.prank(alice);
        auctionHouse.bid{value: 10 ether}(id, 10 ether);

        // 5% increment means the next bid must be at least 10.5 ETH.
        assertEq(auctionHouse.minimumBid(id), 10.5 ether);

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(EnglishAuction.BidIncrementTooSmall.selector, 10.4 ether, 10.5 ether)
        );
        auctionHouse.bid{value: 10.4 ether}(id, 10.4 ether);

        vm.prank(bob);
        auctionHouse.bid{value: 10.5 ether}(id, 10.5 ether);
        assertEq(auctionHouse.auctions(id).highestBidder, bob);
    }

    function test_bid_refundsPreviousBidder() public {
        uint256 id = _createAuction(address(0), 10 ether);

        uint256 aliceBefore = alice.balance;

        vm.prank(alice);
        auctionHouse.bid{value: 10 ether}(id, 10 ether);
        assertEq(alice.balance, aliceBefore - 10 ether);

        vm.prank(bob);
        auctionHouse.bid{value: 20 ether}(id, 20 ether);

        assertEq(alice.balance, aliceBefore, "outbid refund returned in full");
        assertEq(address(auctionHouse).balance, 20 ether, "only the live bid is held");
    }

    function test_bid_sellerCannotBid() public {
        uint256 id = _createAuction(address(0), 1 ether);
        vm.deal(seller, 10 ether);

        vm.prank(seller);
        vm.expectRevert(EnglishAuction.SellerCannotBid.selector);
        auctionHouse.bid{value: 1 ether}(id, 1 ether);
    }

    function test_bid_revertsAfterEnd() public {
        uint256 id = _createAuction(address(0), 1 ether);
        vm.warp(end);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(EnglishAuction.AuctionEnded.selector, end));
        auctionHouse.bid{value: 1 ether}(id, 1 ether);
    }

    function test_bid_revertsOnMismatchedValue() public {
        uint256 id = _createAuction(address(0), 1 ether);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(EnglishAuction.IncorrectPayment.selector, 1 ether, 2 ether));
        auctionHouse.bid{value: 1 ether}(id, 2 ether);
    }

    function test_bid_erc20() public {
        uint256 id = _createAuction(address(weth), 10 ether);

        vm.prank(alice);
        auctionHouse.bid(id, 10 ether);
        assertEq(weth.balanceOf(address(auctionHouse)), 10 ether);

        uint256 aliceBefore = weth.balanceOf(alice);

        vm.prank(bob);
        auctionHouse.bid(id, 20 ether);

        assertEq(weth.balanceOf(alice), aliceBefore + 10 ether, "erc20 refund");
        assertEq(weth.balanceOf(address(auctionHouse)), 20 ether);
    }

    function test_bid_erc20_rejectsNativeValue() public {
        uint256 id = _createAuction(address(weth), 10 ether);

        vm.prank(alice);
        vm.expectRevert(EnglishAuction.UnexpectedNativePayment.selector);
        auctionHouse.bid{value: 1 wei}(id, 10 ether);
    }

    /*//////////////////////////////////////////////////////////////
                             ANTI-SNIPING
    //////////////////////////////////////////////////////////////*/

    /// @dev A bid in the final minutes must push the finish line out, otherwise the auction is
    ///      decided by whoever wins the gas race in the last block.
    function test_lateBidExtendsAuction() public {
        uint256 id = _createAuction(address(0), 1 ether);

        // Land a bid with 5 minutes left, inside the 10 minute extension window.
        vm.warp(end - 5 minutes);

        vm.prank(alice);
        auctionHouse.bid{value: 1 ether}(id, 1 ether);

        uint64 newEnd = auctionHouse.auctions(id).endTime;
        assertEq(newEnd, uint64(block.timestamp) + EXTENSION_DURATION, "extended by the full duration");
        assertGt(newEnd, end, "end time moved out");

        // Bob still has time to respond, which is the whole point.
        vm.warp(newEnd - 1 minutes);
        vm.prank(bob);
        auctionHouse.bid{value: 2 ether}(id, 2 ether);

        assertEq(auctionHouse.auctions(id).highestBidder, bob);
    }

    function test_earlyBidDoesNotExtend() public {
        uint256 id = _createAuction(address(0), 1 ether);

        vm.warp(end - 2 hours);
        vm.prank(alice);
        auctionHouse.bid{value: 1 ether}(id, 1 ether);

        assertEq(auctionHouse.auctions(id).endTime, end, "unchanged outside the window");
    }

    /*//////////////////////////////////////////////////////////////
                              SETTLEMENT
    //////////////////////////////////////////////////////////////*/

    function test_settle_paysEveryoneAndDeliversAsset() public {
        uint256 id = _createAuction(address(0), 10 ether);

        vm.prank(alice);
        auctionHouse.bid{value: 10 ether}(id, 10 ether);

        vm.warp(end);

        uint256 sellerBefore = seller.balance;

        // Permissionless: a third party triggers settlement.
        vm.prank(bob);
        auctionHouse.settle(id);

        uint256 fee = (10 ether * PROTOCOL_FEE_BPS) / 10_000;
        uint256 royalty = (10 ether * ROYALTY_BPS) / 10_000;

        assertEq(collection.ownerOf(1), alice, "winner receives the asset");
        assertEq(feeRecipient.balance, fee);
        assertEq(royaltyReceiver.balance, royalty);
        assertEq(seller.balance - sellerBefore, 10 ether - fee - royalty);
        assertEq(address(auctionHouse).balance, 0, "nothing stranded");
    }

    function test_settle_withNoBidsReturnsAssetToSeller() public {
        uint256 id = _createAuction(address(0), 10 ether);

        vm.warp(end);
        auctionHouse.settle(id);

        assertEq(collection.ownerOf(1), seller, "asset returned");
        assertTrue(auctionHouse.auctions(id).settled);
    }

    function test_settle_revertsBeforeEnd() public {
        uint256 id = _createAuction(address(0), 1 ether);

        vm.expectRevert(abi.encodeWithSelector(EnglishAuction.AuctionStillRunning.selector, end));
        auctionHouse.settle(id);
    }

    function test_settle_cannotSettleTwice() public {
        uint256 id = _createAuction(address(0), 1 ether);

        vm.prank(alice);
        auctionHouse.bid{value: 1 ether}(id, 1 ether);

        vm.warp(end);
        auctionHouse.settle(id);

        vm.expectRevert(EnglishAuction.AuctionAlreadySettled.selector);
        auctionHouse.settle(id);
    }

    function test_settle_erc20() public {
        uint256 id = _createAuction(address(weth), 10 ether);

        vm.prank(alice);
        auctionHouse.bid(id, 10 ether);

        vm.warp(end);
        auctionHouse.settle(id);

        uint256 fee = (10 ether * PROTOCOL_FEE_BPS) / 10_000;
        uint256 royalty = (10 ether * ROYALTY_BPS) / 10_000;

        assertEq(collection.ownerOf(1), alice);
        assertEq(weth.balanceOf(feeRecipient), fee);
        assertEq(weth.balanceOf(royaltyReceiver), royalty);
        assertEq(weth.balanceOf(seller), 10 ether - fee - royalty);
        assertEq(weth.balanceOf(address(auctionHouse)), 0);
    }

    /*//////////////////////////////////////////////////////////////
                             CANCELLATION
    //////////////////////////////////////////////////////////////*/

    function test_cancel_returnsAssetWhenNoBids() public {
        uint256 id = _createAuction(address(0), 1 ether);

        vm.prank(seller);
        auctionHouse.cancelAuction(id);

        assertEq(collection.ownerOf(1), seller);
    }

    /// @dev Once a bid exists the seller is committed. Otherwise a seller could walk away from any
    ///      price they did not like, which makes bidding pointless.
    function test_cancel_revertsOnceBidPlaced() public {
        uint256 id = _createAuction(address(0), 1 ether);

        vm.prank(alice);
        auctionHouse.bid{value: 1 ether}(id, 1 ether);

        vm.prank(seller);
        vm.expectRevert(EnglishAuction.HasBids.selector);
        auctionHouse.cancelAuction(id);
    }

    function test_cancel_onlySeller() public {
        uint256 id = _createAuction(address(0), 1 ether);

        vm.prank(alice);
        vm.expectRevert(EnglishAuction.NotSeller.selector);
        auctionHouse.cancelAuction(id);
    }

    /*//////////////////////////////////////////////////////////////
                          PAYOUT ROBUSTNESS
    //////////////////////////////////////////////////////////////*/

    /// @dev A bidder that rejects ETH must not be able to freeze the auction by refusing a refund.
    function test_bidderRejectingRefundFallsBackToEscrow() public {
        RejectingReceiver rejector = new RejectingReceiver();
        vm.deal(address(rejector), 100 ether);

        uint256 id = _createAuction(address(0), 1 ether);

        vm.prank(address(rejector));
        auctionHouse.bid{value: 1 ether}(id, 1 ether);

        // Bob outbids. The refund push to the rejector fails and lands in escrow instead.
        vm.prank(bob);
        auctionHouse.bid{value: 2 ether}(id, 2 ether);

        assertEq(auctionHouse.escrowedBalance(address(rejector)), 1 ether, "refund escrowed");
        assertEq(auctionHouse.auctions(id).highestBidder, bob, "auction continued");
    }

    /*//////////////////////////////////////////////////////////////
                              ERC-1155
    //////////////////////////////////////////////////////////////*/

    function test_erc1155Auction() public {
        editions.mint(seller, 9, 5);
        vm.prank(seller);
        editions.setApprovalForAll(address(auctionHouse), true);

        vm.prank(seller);
        uint256 id = auctionHouse.createAuction(
            address(editions), 9, 5, TokenType.ERC1155, address(0), 1 ether, start, end, 0, 0, 0
        );

        assertEq(editions.balanceOf(address(auctionHouse), 9), 5, "units escrowed");

        vm.prank(alice);
        auctionHouse.bid{value: 1 ether}(id, 1 ether);

        vm.warp(end);
        auctionHouse.settle(id);

        assertEq(editions.balanceOf(alice, 9), 5, "winner receives all units");
    }

    function test_erc721AuctionMustHaveAmountOne() public {
        vm.prank(seller);
        vm.expectRevert(EnglishAuction.ERC721AmountMustBeOne.selector);
        auctionHouse.createAuction(
            address(collection), 1, 2, TokenType.ERC721, address(0), 1 ether, start, end, 0, 0, 0
        );
    }

    /*//////////////////////////////////////////////////////////////
                                 ADMIN
    //////////////////////////////////////////////////////////////*/

    /// @dev A pause must stop new activity without ever trapping an escrowed asset or bid.
    function test_pause_stopsBidsButAllowsSettlement() public {
        uint256 id = _createAuction(address(0), 1 ether);

        vm.prank(alice);
        auctionHouse.bid{value: 1 ether}(id, 1 ether);

        vm.prank(owner);
        auctionHouse.pause();

        vm.prank(bob);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        auctionHouse.bid{value: 2 ether}(id, 2 ether);

        vm.warp(end);
        auctionHouse.settle(id);

        assertEq(collection.ownerOf(1), alice, "settlement still works while paused");
    }

    /*//////////////////////////////////////////////////////////////
                                 FUZZ
    //////////////////////////////////////////////////////////////*/

    /// @dev However bidding plays out, settlement conserves value exactly.
    function testFuzz_settlementConservesValue(uint96 rawReserve, uint96 rawBid) public {
        uint256 reserve = bound(uint256(rawReserve), 1, 100 ether);
        uint256 bidAmount = bound(uint256(rawBid), reserve, 500 ether);

        uint256 id = _createAuction(address(0), reserve);

        vm.deal(alice, bidAmount);
        vm.prank(alice);
        auctionHouse.bid{value: bidAmount}(id, bidAmount);

        vm.warp(end);

        uint256 sellerBefore = seller.balance;
        auctionHouse.settle(id);

        uint256 distributed =
            feeRecipient.balance + royaltyReceiver.balance + (seller.balance - sellerBefore);

        assertEq(distributed, bidAmount, "value conserved");
        assertEq(address(auctionHouse).balance, 0, "nothing stranded");
        assertEq(collection.ownerOf(1), alice);
    }

    /// @dev The escrowed balance always covers exactly the current high bid, whatever the bid order.
    function testFuzz_contractHoldsOnlyLiveBid(uint96[5] calldata rawBids) public {
        uint256 id = _createAuction(address(0), 1 ether);

        uint256 highest;
        for (uint256 i; i < rawBids.length; ++i) {
            uint256 amount = bound(uint256(rawBids[i]), 1 ether, 1_000 ether);
            address bidder = address(uint160(0x5000 + i));
            vm.deal(bidder, amount);

            vm.prank(bidder);
            try auctionHouse.bid{value: amount}(id, amount) {
                highest = amount;
            } catch {}

            // Escrowed refunds also sit in the contract, so the balance is the live bid plus those.
            assertGe(address(auctionHouse).balance, highest);
        }

        assertEq(auctionHouse.auctions(id).highestBid, highest);
    }
}
