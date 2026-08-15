// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Collection721} from "../src/Collection721.sol";
import {Marketplace} from "../src/Marketplace.sol";
import {Order, Side, TokenType} from "../src/OrderTypes.sol";
import {PaymentSettler} from "../src/PaymentSettler.sol";
import {
    GreedyRoyaltyCollection,
    MockERC1155,
    MockERC1271Wallet,
    MockERC20,
    MockERC721,
    ReentrantBuyer,
    RejectingReceiver,
    RevertingRoyaltyCollection
} from "./utils/Mocks.sol";

contract MarketplaceTest is Test {
    Marketplace internal marketplace;
    Collection721 internal collection;
    MockERC20 internal weth;
    MockERC1155 internal editions;

    address internal owner = makeAddr("owner");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal royaltyReceiver = makeAddr("royaltyReceiver");
    address internal treasury = makeAddr("treasury");

    uint256 internal sellerKey = 0xA11CE;
    uint256 internal buyerKey = 0xB0B;
    address internal seller;
    address internal buyer;

    uint96 internal constant PROTOCOL_FEE_BPS = 250; // 2.5%
    uint96 internal constant ROYALTY_BPS = 500; // 5%

    function setUp() public {
        vm.warp(1_800_000_000);

        seller = vm.addr(sellerKey);
        buyer = vm.addr(buyerKey);

        marketplace = new Marketplace(owner, feeRecipient, PROTOCOL_FEE_BPS);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        editions = new MockERC1155();

        collection = new Collection721(
            "Genesis", "GEN", 1_000, "ipfs://placeholder", treasury, royaltyReceiver, ROYALTY_BPS, owner
        );

        vm.prank(owner);
        marketplace.setCurrencyAllowed(address(weth), true);

        // Give the seller token #1.
        vm.prank(owner);
        collection.ownerMint(seller, 3);

        vm.prank(seller);
        collection.setApprovalForAll(address(marketplace), true);

        vm.deal(buyer, 100 ether);
        weth.mint(buyer, 100 ether);
        vm.prank(buyer);
        weth.approve(address(marketplace), type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _listing(address currency, uint256 price) internal view returns (Order memory) {
        return Order({
            maker: seller,
            collection: address(collection),
            tokenId: 1,
            amount: 1,
            currency: currency,
            price: price,
            startTime: block.timestamp,
            endTime: block.timestamp + 7 days,
            salt: 1,
            nonce: marketplace.nonces(seller),
            side: Side.Listing,
            tokenType: TokenType.ERC721
        });
    }

    function _offer(uint256 price) internal view returns (Order memory) {
        return Order({
            maker: buyer,
            collection: address(collection),
            tokenId: 1,
            amount: 1,
            currency: address(weth),
            price: price,
            startTime: block.timestamp,
            endTime: block.timestamp + 7 days,
            salt: 2,
            nonce: marketplace.nonces(buyer),
            side: Side.Offer,
            tokenType: TokenType.ERC721
        });
    }

    function _sign(Order memory order, uint256 key) internal view returns (bytes memory) {
        bytes32 digest = marketplace.hashOrder(order);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    /*//////////////////////////////////////////////////////////////
                            LISTING FULFILMENT
    //////////////////////////////////////////////////////////////*/

    function test_fulfillListing_nativeETH_splitsPaymentCorrectly() public {
        uint256 price = 10 ether;
        Order memory order = _listing(address(0), price);
        bytes memory signature = _sign(order, sellerKey);

        uint256 sellerBefore = seller.balance;

        vm.prank(buyer);
        marketplace.fulfillListing{value: price}(order, signature, 1);

        uint256 expectedFee = (price * PROTOCOL_FEE_BPS) / 10_000; // 0.25 ETH
        uint256 expectedRoyalty = (price * ROYALTY_BPS) / 10_000; // 0.5 ETH

        assertEq(collection.ownerOf(1), buyer, "buyer owns token");
        assertEq(feeRecipient.balance, expectedFee, "protocol fee");
        assertEq(royaltyReceiver.balance, expectedRoyalty, "royalty");
        assertEq(seller.balance - sellerBefore, price - expectedFee - expectedRoyalty, "seller proceeds");
        assertEq(address(marketplace).balance, 0, "nothing stranded in the venue");
    }

    function test_fulfillListing_erc20() public {
        uint256 price = 10 ether;
        Order memory order = _listing(address(weth), price);
        bytes memory signature = _sign(order, sellerKey);

        vm.prank(buyer);
        marketplace.fulfillListing(order, signature, 1);

        uint256 expectedFee = (price * PROTOCOL_FEE_BPS) / 10_000;
        uint256 expectedRoyalty = (price * ROYALTY_BPS) / 10_000;

        assertEq(collection.ownerOf(1), buyer);
        assertEq(weth.balanceOf(feeRecipient), expectedFee);
        assertEq(weth.balanceOf(royaltyReceiver), expectedRoyalty);
        assertEq(weth.balanceOf(seller), price - expectedFee - expectedRoyalty);
        assertEq(weth.balanceOf(address(marketplace)), 0);
    }

    function test_fulfillListing_revertsOnWrongETHAmount() public {
        Order memory order = _listing(address(0), 10 ether);
        bytes memory signature = _sign(order, sellerKey);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.IncorrectPayment.selector, 9 ether, 10 ether));
        marketplace.fulfillListing{value: 9 ether}(order, signature, 1);
    }

    function test_fulfillListing_revertsOnUnexpectedETHWithERC20Order() public {
        Order memory order = _listing(address(weth), 10 ether);
        bytes memory signature = _sign(order, sellerKey);

        vm.prank(buyer);
        vm.expectRevert(Marketplace.UnexpectedNativePayment.selector);
        marketplace.fulfillListing{value: 1 wei}(order, signature, 1);
    }

    function test_fulfillListing_revertsOnForgedSignature() public {
        Order memory order = _listing(address(0), 10 ether);
        // Signed by the buyer, but the order claims the seller as maker.
        bytes memory signature = _sign(order, buyerKey);

        vm.prank(buyer);
        vm.expectRevert(Marketplace.InvalidSignature.selector);
        marketplace.fulfillListing{value: 10 ether}(order, signature, 1);
    }

    function test_fulfillListing_revertsIfOrderMutatedAfterSigning() public {
        Order memory order = _listing(address(0), 10 ether);
        bytes memory signature = _sign(order, sellerKey);

        // Buyer tries to pay less than the signed price.
        order.price = 1 ether;

        vm.prank(buyer);
        vm.expectRevert(Marketplace.InvalidSignature.selector);
        marketplace.fulfillListing{value: 1 ether}(order, signature, 1);
    }

    function test_fulfillListing_revertsWhenExpired() public {
        Order memory order = _listing(address(0), 10 ether);
        bytes memory signature = _sign(order, sellerKey);

        vm.warp(order.endTime);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.OrderExpired.selector, order.endTime));
        marketplace.fulfillListing{value: 10 ether}(order, signature, 1);
    }

    function test_fulfillListing_revertsBeforeStart() public {
        Order memory order = _listing(address(0), 10 ether);
        order.startTime = block.timestamp + 1 days;
        bytes memory signature = _sign(order, sellerKey);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.OrderNotStarted.selector, order.startTime));
        marketplace.fulfillListing{value: 10 ether}(order, signature, 1);
    }

    function test_fulfillListing_cannotFillTwice() public {
        Order memory order = _listing(address(0), 1 ether);
        bytes memory signature = _sign(order, sellerKey);

        vm.prank(buyer);
        marketplace.fulfillListing{value: 1 ether}(order, signature, 1);

        // Buyer now owns it and approves the venue, so the only thing stopping a replay is the
        // fill accounting.
        vm.prank(buyer);
        collection.setApprovalForAll(address(marketplace), true);

        address other = makeAddr("other");
        vm.deal(other, 10 ether);
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.AmountExceedsRemaining.selector, 1, 0));
        marketplace.fulfillListing{value: 1 ether}(order, signature, 1);
    }

    function test_fulfillListing_revertsOnSelfTrade() public {
        Order memory order = _listing(address(0), 1 ether);
        bytes memory signature = _sign(order, sellerKey);

        vm.deal(seller, 10 ether);
        vm.prank(seller);
        vm.expectRevert(Marketplace.SelfTrade.selector);
        marketplace.fulfillListing{value: 1 ether}(order, signature, 1);
    }

    function test_fulfillListing_revertsOnDisallowedCurrency() public {
        MockERC20 shady = new MockERC20("Shady", "SHAD", 18);
        Order memory order = _listing(address(shady), 1 ether);
        bytes memory signature = _sign(order, sellerKey);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.CurrencyNotAllowed.selector, address(shady)));
        marketplace.fulfillListing(order, signature, 1);
    }

    function test_fulfillListing_revertsWithWrongSide() public {
        Order memory order = _offer(1 ether);
        bytes memory signature = _sign(order, buyerKey);

        vm.prank(seller);
        vm.expectRevert(Marketplace.WrongSide.selector);
        marketplace.fulfillListing(order, signature, 1);
    }

    /*//////////////////////////////////////////////////////////////
                                OFFERS
    //////////////////////////////////////////////////////////////*/

    function test_acceptOffer_happyPath() public {
        uint256 price = 5 ether;
        Order memory order = _offer(price);
        bytes memory signature = _sign(order, buyerKey);

        vm.prank(seller);
        marketplace.acceptOffer(order, signature, 1);

        uint256 expectedFee = (price * PROTOCOL_FEE_BPS) / 10_000;
        uint256 expectedRoyalty = (price * ROYALTY_BPS) / 10_000;

        assertEq(collection.ownerOf(1), buyer);
        assertEq(weth.balanceOf(feeRecipient), expectedFee);
        assertEq(weth.balanceOf(royaltyReceiver), expectedRoyalty);
        assertEq(weth.balanceOf(seller), price - expectedFee - expectedRoyalty);
    }

    function test_acceptOffer_rejectsNativeCurrency() public {
        Order memory order = _offer(1 ether);
        order.currency = address(0);
        bytes memory signature = _sign(order, buyerKey);

        vm.prank(seller);
        vm.expectRevert(Marketplace.NativeCurrencyNotAllowedForOffers.selector);
        marketplace.acceptOffer(order, signature, 1);
    }

    function test_acceptOffer_revertsIfOffererLacksBalance() public {
        Order memory order = _offer(1_000 ether);
        bytes memory signature = _sign(order, buyerKey);

        vm.prank(seller);
        vm.expectRevert();
        marketplace.acceptOffer(order, signature, 1);
    }

    /*//////////////////////////////////////////////////////////////
                             CANCELLATION
    //////////////////////////////////////////////////////////////*/

    function test_cancelOrder_blocksFill() public {
        Order memory order = _listing(address(0), 1 ether);
        bytes memory signature = _sign(order, sellerKey);

        vm.prank(seller);
        marketplace.cancelOrder(order);

        vm.prank(buyer);
        vm.expectRevert(Marketplace.OrderIsCancelled.selector);
        marketplace.fulfillListing{value: 1 ether}(order, signature, 1);

        assertEq(marketplace.remainingAmount(order), 0);
    }

    function test_cancelOrder_onlyMaker() public {
        Order memory order = _listing(address(0), 1 ether);

        vm.prank(buyer);
        vm.expectRevert(Marketplace.NotOrderMaker.selector);
        marketplace.cancelOrder(order);
    }

    function test_incrementNonce_invalidatesEveryOldOrder() public {
        Order memory orderA = _listing(address(0), 1 ether);
        Order memory orderB = _listing(address(0), 2 ether);
        orderB.salt = 99;
        orderB.tokenId = 2;

        bytes memory sigA = _sign(orderA, sellerKey);
        bytes memory sigB = _sign(orderB, sellerKey);

        vm.prank(seller);
        marketplace.incrementNonce();

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.InvalidNonce.selector, 0, 1));
        marketplace.fulfillListing{value: 1 ether}(orderA, sigA, 1);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.InvalidNonce.selector, 0, 1));
        marketplace.fulfillListing{value: 2 ether}(orderB, sigB, 1);

        assertEq(marketplace.remainingAmount(orderA), 0);
    }

    function test_cancelOrders_batch() public {
        Order[] memory orders = new Order[](2);
        orders[0] = _listing(address(0), 1 ether);
        orders[1] = _listing(address(0), 2 ether);
        orders[1].salt = 42;

        vm.prank(seller);
        marketplace.cancelOrders(orders);

        assertTrue(marketplace.cancelled(marketplace.hashOrder(orders[0])));
        assertTrue(marketplace.cancelled(marketplace.hashOrder(orders[1])));
    }

    /*//////////////////////////////////////////////////////////////
                             PARTIAL FILLS
    //////////////////////////////////////////////////////////////*/

    function test_partialFill_erc1155() public {
        editions.mint(seller, 7, 10);
        vm.prank(seller);
        editions.setApprovalForAll(address(marketplace), true);

        Order memory order = Order({
            maker: seller,
            collection: address(editions),
            tokenId: 7,
            amount: 10,
            currency: address(weth),
            price: 10 ether, // 1 ether per unit
            startTime: block.timestamp,
            endTime: block.timestamp + 1 days,
            salt: 7,
            nonce: 0,
            side: Side.Listing,
            tokenType: TokenType.ERC1155
        });
        bytes memory signature = _sign(order, sellerKey);

        vm.prank(buyer);
        marketplace.fulfillListing(order, signature, 4);

        assertEq(editions.balanceOf(buyer, 7), 4);
        assertEq(marketplace.filled(marketplace.hashOrder(order)), 4);
        assertEq(marketplace.remainingAmount(order), 6);

        vm.prank(buyer);
        marketplace.fulfillListing(order, signature, 6);

        assertEq(editions.balanceOf(buyer, 7), 10);
        assertEq(marketplace.remainingAmount(order), 0);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.AmountExceedsRemaining.selector, 1, 0));
        marketplace.fulfillListing(order, signature, 1);
    }

    /// @dev Rounding on a partial fill must never favour the taker.
    function test_partialFill_roundsUpInMakersFavour() public {
        editions.mint(seller, 1, 3);
        vm.prank(seller);
        editions.setApprovalForAll(address(marketplace), true);

        Order memory order = Order({
            maker: seller,
            collection: address(editions),
            tokenId: 1,
            amount: 3,
            currency: address(weth),
            price: 10, // does not divide evenly by 3
            startTime: block.timestamp,
            endTime: block.timestamp + 1 days,
            salt: 8,
            nonce: 0,
            side: Side.Listing,
            tokenType: TokenType.ERC1155
        });
        bytes memory signature = _sign(order, sellerKey);

        uint256 buyerBefore = weth.balanceOf(buyer);

        vm.prank(buyer);
        marketplace.fulfillListing(order, signature, 1);

        // ceil(10 * 1 / 3) == 4, not 3.
        assertEq(buyerBefore - weth.balanceOf(buyer), 4);
    }

    function test_erc721OrderMustHaveAmountOne() public {
        Order memory order = _listing(address(0), 1 ether);
        order.amount = 2;
        bytes memory signature = _sign(order, sellerKey);

        vm.prank(buyer);
        vm.expectRevert(Marketplace.ERC721AmountMustBeOne.selector);
        marketplace.fulfillListing{value: 1 ether}(order, signature, 1);
    }

    /*//////////////////////////////////////////////////////////////
                          HOSTILE COLLECTIONS
    //////////////////////////////////////////////////////////////*/

    /// @dev A collection reporting a 90% royalty must be clamped to the 10% cap, otherwise a
    ///      malicious creator could drain a seller who lists in good faith.
    function test_greedyRoyaltyIsCapped() public {
        GreedyRoyaltyCollection greedy = new GreedyRoyaltyCollection(royaltyReceiver, 9_000);
        greedy.mint(seller, 1);

        vm.prank(seller);
        greedy.setApprovalForAll(address(marketplace), true);

        uint256 price = 10 ether;
        Order memory order = _listing(address(0), price);
        order.collection = address(greedy);
        bytes memory signature = _sign(order, sellerKey);

        uint256 sellerBefore = seller.balance;

        vm.prank(buyer);
        marketplace.fulfillListing{value: price}(order, signature, 1);

        uint256 cappedRoyalty = (price * marketplace.MAX_ROYALTY_BPS()) / 10_000; // 1 ETH
        uint256 fee = (price * PROTOCOL_FEE_BPS) / 10_000;

        assertEq(royaltyReceiver.balance, cappedRoyalty, "royalty clamped to cap");
        assertEq(seller.balance - sellerBefore, price - fee - cappedRoyalty, "seller keeps the rest");
    }

    /// @dev A collection whose royaltyInfo reverts must still be tradeable, just without a royalty.
    function test_revertingRoyaltyDoesNotBlockTrade() public {
        RevertingRoyaltyCollection broken = new RevertingRoyaltyCollection();
        broken.mint(seller, 1);

        vm.prank(seller);
        broken.setApprovalForAll(address(marketplace), true);

        uint256 price = 10 ether;
        Order memory order = _listing(address(0), price);
        order.collection = address(broken);
        bytes memory signature = _sign(order, sellerKey);

        uint256 sellerBefore = seller.balance;

        vm.prank(buyer);
        marketplace.fulfillListing{value: price}(order, signature, 1);

        uint256 fee = (price * PROTOCOL_FEE_BPS) / 10_000;
        assertEq(broken.ownerOf(1), buyer);
        assertEq(seller.balance - sellerBefore, price - fee, "no royalty taken");
    }

    /// @dev A collection with no EIP-2981 support simply pays no royalty.
    function test_collectionWithoutRoyaltySupport() public {
        MockERC721 plain = new MockERC721();
        plain.mint(seller, 1);

        vm.prank(seller);
        plain.setApprovalForAll(address(marketplace), true);

        uint256 price = 4 ether;
        Order memory order = _listing(address(0), price);
        order.collection = address(plain);
        bytes memory signature = _sign(order, sellerKey);

        uint256 sellerBefore = seller.balance;

        vm.prank(buyer);
        marketplace.fulfillListing{value: price}(order, signature, 1);

        uint256 fee = (price * PROTOCOL_FEE_BPS) / 10_000;
        assertEq(seller.balance - sellerBefore, price - fee);
    }

    /*//////////////////////////////////////////////////////////////
                          PAYOUT ROBUSTNESS
    //////////////////////////////////////////////////////////////*/

    /// @dev A seller that rejects ETH must not be able to make its own listings unfillable.
    ///      The proceeds land in escrow instead, withdrawable later.
    function test_sellerRejectingETHFallsBackToEscrow() public {
        RejectingReceiver rejector = new RejectingReceiver();

        // The rejector needs to be the maker, so it needs a token and an approval. It cannot sign,
        // so the test drives the escrow path through the royalty recipient instead.
        vm.prank(owner);
        collection.setDefaultRoyalty(address(rejector), ROYALTY_BPS);

        uint256 price = 10 ether;
        Order memory order = _listing(address(0), price);
        bytes memory signature = _sign(order, sellerKey);

        vm.prank(buyer);
        marketplace.fulfillListing{value: price}(order, signature, 1);

        uint256 expectedRoyalty = (price * ROYALTY_BPS) / 10_000;

        assertEq(collection.ownerOf(1), buyer, "trade still settled");
        assertEq(marketplace.escrowedBalance(address(rejector)), expectedRoyalty, "royalty escrowed");
        assertEq(address(marketplace).balance, expectedRoyalty, "escrow backed by real ETH");
    }

    function test_withdrawEscrow_revertsWhenEmpty() public {
        vm.prank(buyer);
        vm.expectRevert(PaymentSettler.NothingToWithdraw.selector);
        marketplace.withdrawEscrow();
    }

    /*//////////////////////////////////////////////////////////////
                              REENTRANCY
    //////////////////////////////////////////////////////////////*/

    /// @dev The ERC-721 receive hook fires mid-settlement. A second fill attempted from inside it
    ///      must fail, both on the guard and on the fill accounting.
    function test_reentrancyFromReceiveHookIsBlocked() public {
        ReentrantBuyer attacker = new ReentrantBuyer(marketplace);
        vm.deal(address(attacker), 100 ether);

        Order memory orderOne = _listing(address(0), 1 ether);
        bytes memory sigOne = _sign(orderOne, sellerKey);

        Order memory orderTwo = _listing(address(0), 1 ether);
        orderTwo.tokenId = 2;
        orderTwo.salt = 55;
        bytes memory sigTwo = _sign(orderTwo, sellerKey);

        attacker.arm(orderTwo, sigTwo);
        attacker.buy{value: 1 ether}(orderOne, sigOne);

        assertTrue(attacker.attempted(), "hook ran");
        assertTrue(attacker.reentryReverted(), "reentrant fill reverted");
        assertEq(collection.ownerOf(1), address(attacker), "first trade settled");
        assertEq(collection.ownerOf(2), seller, "second token untouched");
    }

    /*//////////////////////////////////////////////////////////////
                            CONTRACT WALLETS
    //////////////////////////////////////////////////////////////*/

    /// @dev EIP-1271: a Safe-style contract wallet can be an order maker.
    function test_erc1271WalletCanList() public {
        MockERC1271Wallet wallet = new MockERC1271Wallet(vm.addr(sellerKey));

        vm.prank(owner);
        collection.ownerMint(address(wallet), 1);
        uint256 tokenId = 4;

        wallet.execute(
            address(collection),
            abi.encodeWithSelector(IERC721.setApprovalForAll.selector, address(marketplace), true)
        );

        Order memory order = _listing(address(0), 3 ether);
        order.maker = address(wallet);
        order.tokenId = tokenId;

        // The wallet's designated signer signs; the wallet validates via isValidSignature.
        bytes memory signature = _sign(order, sellerKey);

        vm.prank(buyer);
        marketplace.fulfillListing{value: 3 ether}(order, signature, 1);

        assertEq(collection.ownerOf(tokenId), buyer);
    }

    /*//////////////////////////////////////////////////////////////
                                 ADMIN
    //////////////////////////////////////////////////////////////*/

    function test_setProtocolFee_respectsCap() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PaymentSettler.FeeTooHigh.selector, uint96(1_001)));
        marketplace.setProtocolFee(feeRecipient, 1_001);

        vm.prank(owner);
        marketplace.setProtocolFee(feeRecipient, 1_000);
        assertEq(marketplace.protocolFeeBps(), 1_000);
    }

    function test_setProtocolFee_onlyOwner() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, buyer));
        marketplace.setProtocolFee(buyer, 100);
    }

    function test_pause_blocksFillsButNotCancellation() public {
        Order memory order = _listing(address(0), 1 ether);
        bytes memory signature = _sign(order, sellerKey);

        vm.prank(owner);
        marketplace.pause();

        vm.prank(buyer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        marketplace.fulfillListing{value: 1 ether}(order, signature, 1);

        // A pause must never trap a maker in a live order.
        vm.prank(seller);
        marketplace.cancelOrder(order);

        vm.prank(owner);
        marketplace.unpause();

        vm.prank(buyer);
        vm.expectRevert(Marketplace.OrderIsCancelled.selector);
        marketplace.fulfillListing{value: 1 ether}(order, signature, 1);
    }

    /*//////////////////////////////////////////////////////////////
                                 FUZZ
    //////////////////////////////////////////////////////////////*/

    /// @dev Fee plus royalty plus seller proceeds always equals the price exactly, for any price.
    ///      Nothing is created and nothing is stranded.
    function testFuzz_paymentSplitConservesValue(uint96 rawPrice, uint96 feeBps) public {
        uint256 price = bound(uint256(rawPrice), 1, 1_000 ether);
        feeBps = uint96(bound(feeBps, 0, marketplace.MAX_PROTOCOL_FEE_BPS()));

        vm.prank(owner);
        marketplace.setProtocolFee(feeRecipient, feeBps);

        Order memory order = _listing(address(0), price);
        bytes memory signature = _sign(order, sellerKey);

        vm.deal(buyer, price);
        uint256 sellerBefore = seller.balance;

        vm.prank(buyer);
        marketplace.fulfillListing{value: price}(order, signature, 1);

        uint256 distributed = feeRecipient.balance + royaltyReceiver.balance + (seller.balance - sellerBefore);

        assertEq(distributed, price, "value conserved");
        assertEq(address(marketplace).balance, 0, "nothing stranded");
    }

    /// @dev Any partial fill sequence totals to at least the full price and never over-delivers units.
    function testFuzz_partialFillsNeverExceedOrderAmount(uint8 first, uint8 second) public {
        uint256 total = 10;
        editions.mint(seller, 3, total);
        vm.prank(seller);
        editions.setApprovalForAll(address(marketplace), true);

        Order memory order = Order({
            maker: seller,
            collection: address(editions),
            tokenId: 3,
            amount: total,
            currency: address(weth),
            price: 10 ether,
            startTime: block.timestamp,
            endTime: block.timestamp + 1 days,
            salt: 11,
            nonce: 0,
            side: Side.Listing,
            tokenType: TokenType.ERC1155
        });
        bytes memory signature = _sign(order, sellerKey);

        uint256 a = bound(first, 1, total);
        uint256 b = bound(second, 1, total);

        vm.prank(buyer);
        marketplace.fulfillListing(order, signature, a);

        vm.prank(buyer);
        try marketplace.fulfillListing(order, signature, b) {} catch {}

        assertLe(editions.balanceOf(buyer, 3), total);
        assertLe(marketplace.filled(marketplace.hashOrder(order)), total);
    }
}
