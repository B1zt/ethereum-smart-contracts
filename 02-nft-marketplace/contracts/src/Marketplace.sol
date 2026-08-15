// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Order, OrderTypes, Side, TokenType} from "./OrderTypes.sol";
import {PaymentSettler} from "./PaymentSettler.sol";

/// @title Marketplace
/// @notice Gasless NFT order book. Makers sign EIP-712 orders off-chain, takers settle them on-chain.
///
/// @dev The parts that usually go wrong, and how they are handled here:
///
///      - **Listing costs nothing.** No storage is touched until a trade settles. Cancelling one
///        order is one storage write; cancelling every order a maker ever signed is also one write,
///        via the nonce bump.
///
///      - **Contract wallets work.** Signatures go through {SignatureChecker}, so Safe multisigs
///        and other EIP-1271 wallets can trade, not just EOAs.
///
///      - **Partial fills are supported** for ERC-1155, with the price prorated and rounded up so
///        the maker is never short-changed.
///
///      Fee, royalty and payout handling live in {PaymentSettler}.
contract Marketplace is EIP712, Pausable, PaymentSettler {
    using OrderTypes for Order;

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error InvalidSignature();
    error NotOrderMaker();
    error OrderExpired(uint256 endTime);
    error OrderNotStarted(uint256 startTime);
    error OrderIsCancelled();
    error InvalidNonce(uint256 signed, uint256 current);
    error WrongSide();
    error ZeroAmount();
    error AmountExceedsRemaining(uint256 requested, uint256 remaining);
    error ERC721AmountMustBeOne();
    error NativeCurrencyNotAllowedForOffers();
    error IncorrectPayment(uint256 sent, uint256 expected);
    error UnexpectedNativePayment();
    error SelfTrade();
    error CurrencyNotAllowed(address currency);

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event OrderFilled(
        bytes32 indexed orderHash,
        address indexed maker,
        address indexed taker,
        address collection,
        uint256 tokenId,
        uint256 amount,
        address currency,
        uint256 price,
        Side side
    );
    event OrderCancelled(bytes32 indexed orderHash, address indexed maker);
    event NonceIncremented(address indexed maker, uint256 newNonce);
    event CurrencyAllowanceUpdated(address indexed currency, bool allowed);

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Units already filled per order hash, for partial ERC-1155 fills.
    mapping(bytes32 orderHash => uint256 filled) public filled;

    /// @notice Explicitly cancelled orders.
    mapping(bytes32 orderHash => bool cancelled) public cancelled;

    /// @notice Current nonce per maker. Bumping it invalidates every order signed under the old value.
    mapping(address maker => uint256 nonce) public nonces;

    /// @notice ERC-20s accepted as payment. Native ETH needs no entry and is only valid for listings.
    mapping(address currency => bool allowed) public allowedCurrency;

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(address owner_, address protocolFeeRecipient_, uint96 protocolFeeBps_)
        EIP712("B1zt Marketplace", "1")
        Ownable(owner_)
        PaymentSettler(protocolFeeRecipient_, protocolFeeBps_)
    {}

    /*//////////////////////////////////////////////////////////////
                                TRADING
    //////////////////////////////////////////////////////////////*/

    /// @notice Buy from a signed listing. The caller pays and receives the NFT.
    /// @param order The maker's signed listing.
    /// @param signature EIP-712 signature over `order`, from an EOA or an EIP-1271 wallet.
    /// @param amountToFill Units to buy. Must be 1 for ERC-721.
    function fulfillListing(Order calldata order, bytes calldata signature, uint256 amountToFill)
        external
        payable
        nonReentrant
        whenNotPaused
    {
        if (order.side != Side.Listing) revert WrongSide();

        bytes32 orderHash = _validateOrder(order, signature, amountToFill);
        uint256 price = _proRataPrice(order, amountToFill);

        if (order.currency == address(0)) {
            if (msg.value != price) revert IncorrectPayment(msg.value, price);
        } else {
            if (msg.value != 0) revert UnexpectedNativePayment();
        }

        // Asset: maker -> taker. Funds: taker -> maker, minus fee and royalty.
        // For native ETH the funds are already here via msg.value, hence the `true` below.
        _transferAsset(order, order.maker, msg.sender, amountToFill);
        _settle(
            order.currency,
            msg.sender,
            order.maker,
            order.collection,
            order.tokenId,
            price,
            order.currency == address(0)
        );

        emit OrderFilled(
            orderHash,
            order.maker,
            msg.sender,
            order.collection,
            order.tokenId,
            amountToFill,
            order.currency,
            price,
            Side.Listing
        );
    }

    /// @notice Sell into a signed offer. The caller delivers the NFT and receives the currency.
    /// @dev Offers must be denominated in an ERC-20, because a maker cannot escrow native ETH behind
    ///      a signature. WETH is the usual choice.
    function acceptOffer(Order calldata order, bytes calldata signature, uint256 amountToFill)
        external
        nonReentrant
        whenNotPaused
    {
        if (order.side != Side.Offer) revert WrongSide();
        if (order.currency == address(0)) revert NativeCurrencyNotAllowedForOffers();

        bytes32 orderHash = _validateOrder(order, signature, amountToFill);
        uint256 price = _proRataPrice(order, amountToFill);

        // Asset: taker -> maker. Funds: maker -> taker, minus fee and royalty.
        _transferAsset(order, msg.sender, order.maker, amountToFill);
        _settle(order.currency, order.maker, msg.sender, order.collection, order.tokenId, price, false);

        emit OrderFilled(
            orderHash,
            order.maker,
            msg.sender,
            order.collection,
            order.tokenId,
            amountToFill,
            order.currency,
            price,
            Side.Offer
        );
    }

    /*//////////////////////////////////////////////////////////////
                            ORDER VALIDATION
    //////////////////////////////////////////////////////////////*/

    /// @dev Every check independent of trade direction, followed by booking the fill.
    ///      State is written before any external call, so the guard is belt and braces.
    function _validateOrder(Order calldata order, bytes calldata signature, uint256 amountToFill)
        private
        returns (bytes32 orderHash)
    {
        if (amountToFill == 0 || order.amount == 0) revert ZeroAmount();
        if (order.tokenType == TokenType.ERC721 && order.amount != 1) revert ERC721AmountMustBeOne();
        if (order.maker == msg.sender) revert SelfTrade();
        if (block.timestamp < order.startTime) revert OrderNotStarted(order.startTime);
        if (block.timestamp >= order.endTime) revert OrderExpired(order.endTime);
        if (order.currency != address(0) && !allowedCurrency[order.currency]) {
            revert CurrencyNotAllowed(order.currency);
        }

        uint256 currentNonce = nonces[order.maker];
        if (order.nonce != currentNonce) revert InvalidNonce(order.nonce, currentNonce);

        orderHash = _hashTypedDataV4(order.hash());
        if (cancelled[orderHash]) revert OrderIsCancelled();

        uint256 alreadyFilled = filled[orderHash];
        uint256 remaining = order.amount - alreadyFilled;
        if (amountToFill > remaining) revert AmountExceedsRemaining(amountToFill, remaining);

        if (!SignatureChecker.isValidSignatureNow(order.maker, orderHash, signature)) {
            revert InvalidSignature();
        }

        filled[orderHash] = alreadyFilled + amountToFill;
    }

    /// @dev Price for a partial fill, rounded up so rounding never favours the taker.
    function _proRataPrice(Order calldata order, uint256 amountToFill) private pure returns (uint256) {
        if (amountToFill == order.amount) return order.price;
        return Math.ceilDiv(order.price * amountToFill, order.amount);
    }

    /*//////////////////////////////////////////////////////////////
                             CANCELLATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Cancel a single order. Only its maker can.
    /// @dev Not pausable, so a pause can never trap a maker in a live order.
    function cancelOrder(Order calldata order) public {
        if (order.maker != msg.sender) revert NotOrderMaker();

        bytes32 orderHash = _hashTypedDataV4(order.hash());
        cancelled[orderHash] = true;

        emit OrderCancelled(orderHash, msg.sender);
    }

    /// @notice Cancel many orders in one transaction.
    function cancelOrders(Order[] calldata orders) external {
        for (uint256 i; i < orders.length; ++i) {
            cancelOrder(orders[i]);
        }
    }

    /// @notice Invalidate every order the caller has ever signed, for one storage write.
    function incrementNonce() external {
        uint256 newNonce = ++nonces[msg.sender];
        emit NonceIncremented(msg.sender, newNonce);
    }

    /*//////////////////////////////////////////////////////////////
                             ASSET TRANSFER
    //////////////////////////////////////////////////////////////*/

    function _transferAsset(Order calldata order, address from, address to, uint256 amount) private {
        if (order.tokenType == TokenType.ERC721) {
            IERC721(order.collection).safeTransferFrom(from, to, order.tokenId);
        } else {
            IERC1155(order.collection).safeTransferFrom(from, to, order.tokenId, amount, "");
        }
    }

    /*//////////////////////////////////////////////////////////////
                                 ADMIN
    //////////////////////////////////////////////////////////////*/

    /// @notice Allow or disallow an ERC-20 as a payment currency.
    /// @dev An allowlist rather than a free-for-all: fee-on-transfer and rebasing tokens break the
    ///      accounting assumption that the recipient receives exactly what was sent.
    function setCurrencyAllowed(address currency, bool allowed) external onlyOwner {
        if (currency == address(0)) revert ZeroAddress();
        allowedCurrency[currency] = allowed;
        emit CurrencyAllowanceUpdated(currency, allowed);
    }

    /// @notice Halt new fills. Cancellation and escrow withdrawal stay open by design.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice EIP-712 digest for an order, for off-chain signing and order book bookkeeping.
    function hashOrder(Order calldata order) external view returns (bytes32) {
        return _hashTypedDataV4(order.hash());
    }

    /// @notice Units still fillable, accounting for cancellation and nonce bumps.
    function remainingAmount(Order calldata order) external view returns (uint256) {
        if (order.nonce != nonces[order.maker]) return 0;

        bytes32 orderHash = _hashTypedDataV4(order.hash());
        if (cancelled[orderHash]) return 0;

        return order.amount - filled[orderHash];
    }

    /// @notice Domain separator, exposed for off-chain signers.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
