// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ERC165, IERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {TokenType} from "./OrderTypes.sol";
import {PaymentSettler} from "./PaymentSettler.sol";

/// @title EnglishAuction
/// @notice Ascending-price auctions with escrowed assets and anti-sniping time extension.
///
/// @dev Two decisions carry most of the weight here:
///
///      **The NFT is escrowed on creation.** A signature-based auction where the seller keeps
///      custody looks cheaper, but the seller can sell or transfer the asset mid-auction and every
///      bid then settles into a revert. Escrow means a winning bidder always gets the token.
///
///      **Bids extend the clock.** Without this, the winning strategy is to bid in the final block,
///      which turns the auction into a gas race decided by whoever pays the most priority fee.
///      A bid inside the extension window pushes the end time out, so honest bidders always get a
///      chance to respond.
contract EnglishAuction is Pausable, PaymentSettler, ERC165, IERC721Receiver, IERC1155Receiver {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    struct Auction {
        address seller;
        address collection;
        uint256 tokenId;
        /// @dev Units escrowed. Always 1 for ERC-721.
        uint256 amount;
        /// @dev Payment token, or address(0) for native ETH.
        address currency;
        /// @dev Minimum first bid. A lower bid is rejected outright.
        uint256 reservePrice;
        /// @dev Highest bid so far, zero until the first bid lands.
        uint256 highestBid;
        address highestBidder;
        uint64 startTime;
        uint64 endTime;
        /// @dev Bids landing within this many seconds of `endTime` push it out.
        uint32 extensionWindow;
        /// @dev How far a late bid pushes `endTime` out.
        uint32 extensionDuration;
        /// @dev Minimum increment over the current high bid, in basis points.
        uint16 minBidIncrementBps;
        TokenType tokenType;
        bool settled;
    }

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error AuctionDoesNotExist(uint256 auctionId);
    error AuctionNotStarted(uint256 startTime);
    error AuctionEnded(uint256 endTime);
    error AuctionStillRunning(uint256 endTime);
    error AuctionAlreadySettled();
    error InvalidWindow();
    error InvalidExtension();
    error ZeroAmount();
    error ERC721AmountMustBeOne();
    error BidBelowReserve(uint256 bid, uint256 reserve);
    error BidIncrementTooSmall(uint256 bid, uint256 minimum);
    error IncorrectPayment(uint256 sent, uint256 expected);
    error UnexpectedNativePayment();
    error SellerCannotBid();
    error NotSeller();
    error HasBids();
    error CurrencyNotAllowed(address currency);
    error IncrementTooHigh(uint16 bps);

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event AuctionCreated(uint256 indexed auctionId, address indexed seller, address indexed collection, Auction auction);
    event BidPlaced(uint256 indexed auctionId, address indexed bidder, uint256 amount, uint64 newEndTime);
    event AuctionExtended(uint256 indexed auctionId, uint64 newEndTime);
    event AuctionSettled(uint256 indexed auctionId, address indexed winner, uint256 amount);
    event AuctionCancelled(uint256 indexed auctionId);
    event CurrencyAllowanceUpdated(address indexed currency, bool allowed);

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Upper bound on the required bid increment, so a seller cannot set an increment so
    ///         large that only they can realistically outbid.
    uint16 public constant MAX_BID_INCREMENT_BPS = 5_000;

    /// @notice Upper bound on how far a single late bid can push the end time.
    uint32 public constant MAX_EXTENSION_DURATION = 1 hours;

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    uint256 public auctionCount;

    mapping(uint256 auctionId => Auction) private _auctions;

    /// @notice ERC-20s accepted as a bidding currency.
    mapping(address currency => bool allowed) public allowedCurrency;

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(address owner_, address protocolFeeRecipient_, uint96 protocolFeeBps_)
        Ownable(owner_)
        PaymentSettler(protocolFeeRecipient_, protocolFeeBps_)
    {}

    /*//////////////////////////////////////////////////////////////
                            AUCTION LIFECYCLE
    //////////////////////////////////////////////////////////////*/

    /// @notice Escrow an asset and open an auction on it.
    /// @dev The caller must have approved this contract for the asset first.
    function createAuction(
        address collection,
        uint256 tokenId,
        uint256 amount,
        TokenType tokenType,
        address currency,
        uint256 reservePrice,
        uint64 startTime,
        uint64 endTime,
        uint32 extensionWindow,
        uint32 extensionDuration,
        uint16 minBidIncrementBps
    ) external whenNotPaused nonReentrant returns (uint256 auctionId) {
        if (amount == 0) revert ZeroAmount();
        if (tokenType == TokenType.ERC721 && amount != 1) revert ERC721AmountMustBeOne();
        if (startTime >= endTime || endTime <= block.timestamp) revert InvalidWindow();
        if (extensionDuration > MAX_EXTENSION_DURATION) revert InvalidExtension();
        // An extension window with no duration silently disables anti-sniping, which is worse than
        // rejecting the config outright.
        if (extensionWindow != 0 && extensionDuration == 0) revert InvalidExtension();
        if (minBidIncrementBps > MAX_BID_INCREMENT_BPS) revert IncrementTooHigh(minBidIncrementBps);
        if (currency != address(0) && !allowedCurrency[currency]) revert CurrencyNotAllowed(currency);

        auctionId = auctionCount++;

        _auctions[auctionId] = Auction({
            seller: msg.sender,
            collection: collection,
            tokenId: tokenId,
            amount: amount,
            currency: currency,
            reservePrice: reservePrice,
            highestBid: 0,
            highestBidder: address(0),
            startTime: startTime,
            endTime: endTime,
            extensionWindow: extensionWindow,
            extensionDuration: extensionDuration,
            minBidIncrementBps: minBidIncrementBps,
            tokenType: tokenType,
            settled: false
        });

        // Escrow last, so all validation happens before we take custody of anything.
        if (tokenType == TokenType.ERC721) {
            IERC721(collection).safeTransferFrom(msg.sender, address(this), tokenId);
        } else {
            IERC1155(collection).safeTransferFrom(msg.sender, address(this), tokenId, amount, "");
        }

        emit AuctionCreated(auctionId, msg.sender, collection, _auctions[auctionId]);
    }

    /// @notice Place a bid. Send `msg.value` for native auctions, or approve the ERC-20 first.
    /// @param auctionId Auction to bid on.
    /// @param bidAmount Bid size. Must equal `msg.value` for native auctions.
    function bid(uint256 auctionId, uint256 bidAmount) external payable nonReentrant whenNotPaused {
        Auction storage auction = _auctions[auctionId];
        if (auction.seller == address(0)) revert AuctionDoesNotExist(auctionId);
        if (auction.settled) revert AuctionAlreadySettled();
        if (block.timestamp < auction.startTime) revert AuctionNotStarted(auction.startTime);
        if (block.timestamp >= auction.endTime) revert AuctionEnded(auction.endTime);
        if (msg.sender == auction.seller) revert SellerCannotBid();

        if (auction.currency == address(0)) {
            if (msg.value != bidAmount) revert IncorrectPayment(msg.value, bidAmount);
        } else {
            if (msg.value != 0) revert UnexpectedNativePayment();
        }

        uint256 currentBid = auction.highestBid;
        if (currentBid == 0) {
            if (bidAmount < auction.reservePrice) revert BidBelowReserve(bidAmount, auction.reservePrice);
        } else {
            uint256 minimum = currentBid + (currentBid * auction.minBidIncrementBps) / BPS_DENOMINATOR;
            // Guard against an increment that rounds to zero on tiny bids.
            if (minimum == currentBid) minimum = currentBid + 1;
            if (bidAmount < minimum) revert BidIncrementTooSmall(bidAmount, minimum);
        }

        address previousBidder = auction.highestBidder;
        uint256 previousBid = currentBid;

        auction.highestBid = bidAmount;
        auction.highestBidder = msg.sender;

        // Anti-sniping. A bid near the end pushes the finish line out.
        uint64 newEndTime = auction.endTime;
        if (auction.extensionWindow != 0 && auction.endTime - block.timestamp <= auction.extensionWindow) {
            newEndTime = uint64(block.timestamp) + auction.extensionDuration;
            if (newEndTime > auction.endTime) {
                auction.endTime = newEndTime;
                emit AuctionExtended(auctionId, newEndTime);
            } else {
                newEndTime = auction.endTime;
            }
        }

        // Pull the new bid in before refunding the old one.
        if (auction.currency != address(0)) {
            IERC20(auction.currency).safeTransferFrom(msg.sender, address(this), bidAmount);
        }

        if (previousBidder != address(0)) {
            _refundBid(auction.currency, previousBidder, previousBid);
        }

        emit BidPlaced(auctionId, msg.sender, bidAmount, newEndTime);
    }

    /// @notice Settle a finished auction. Permissionless: anyone can trigger it once time is up.
    /// @dev Whoever calls it, the asset goes to the winner and the funds to the seller. Leaving it
    ///      open means a settlement can never be held hostage by an absent seller or winner.
    function settle(uint256 auctionId) external nonReentrant {
        Auction storage auction = _auctions[auctionId];
        if (auction.seller == address(0)) revert AuctionDoesNotExist(auctionId);
        if (auction.settled) revert AuctionAlreadySettled();
        if (block.timestamp < auction.endTime) revert AuctionStillRunning(auction.endTime);

        auction.settled = true;

        address winner = auction.highestBidder;
        uint256 winningBid = auction.highestBid;

        if (winner == address(0)) {
            // Reserve never met. Return the asset to the seller.
            _transferAsset(auction, auction.seller);
            emit AuctionSettled(auctionId, address(0), 0);
            return;
        }

        _transferAsset(auction, winner);

        // Funds are already escrowed in this contract, hence `true`.
        _settle(
            auction.currency, address(this), auction.seller, auction.collection, auction.tokenId, winningBid, true
        );

        emit AuctionSettled(auctionId, winner, winningBid);
    }

    /// @notice Cancel an auction that has not received a bid and reclaim the asset.
    /// @dev Once a bid exists the seller is committed. Allowing cancellation after bidding would
    ///      let a seller walk away from a price they no longer like.
    function cancelAuction(uint256 auctionId) external nonReentrant {
        Auction storage auction = _auctions[auctionId];
        if (auction.seller == address(0)) revert AuctionDoesNotExist(auctionId);
        if (auction.settled) revert AuctionAlreadySettled();
        if (msg.sender != auction.seller) revert NotSeller();
        if (auction.highestBidder != address(0)) revert HasBids();

        auction.settled = true;
        _transferAsset(auction, auction.seller);

        emit AuctionCancelled(auctionId);
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNAL
    //////////////////////////////////////////////////////////////*/

    function _transferAsset(Auction storage auction, address to) private {
        if (auction.tokenType == TokenType.ERC721) {
            IERC721(auction.collection).safeTransferFrom(address(this), to, auction.tokenId);
        } else {
            IERC1155(auction.collection).safeTransferFrom(address(this), to, auction.tokenId, auction.amount, "");
        }
    }

    /// @dev Refunds an outbid bidder, falling back to escrow if they reject the push. A bidder that
    ///      reverts on receiving ETH must not be able to freeze the auction they are losing.
    function _refundBid(address currency, address to, uint256 amount) private {
        if (currency == address(0)) {
            _payNative(to, amount);
        } else {
            IERC20(currency).safeTransfer(to, amount);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                 ADMIN
    //////////////////////////////////////////////////////////////*/

    function setCurrencyAllowed(address currency, bool allowed) external onlyOwner {
        if (currency == address(0)) revert ZeroAddress();
        allowedCurrency[currency] = allowed;
        emit CurrencyAllowanceUpdated(currency, allowed);
    }

    /// @notice Halt new auctions and bids. Settlement, cancellation and escrow withdrawal stay open,
    ///         so a pause can never strand an asset or a bid.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    function auctions(uint256 auctionId) external view returns (Auction memory) {
        if (_auctions[auctionId].seller == address(0)) revert AuctionDoesNotExist(auctionId);
        return _auctions[auctionId];
    }

    /// @notice Smallest bid that would currently be accepted.
    function minimumBid(uint256 auctionId) external view returns (uint256) {
        Auction storage auction = _auctions[auctionId];
        if (auction.seller == address(0)) revert AuctionDoesNotExist(auctionId);

        uint256 currentBid = auction.highestBid;
        if (currentBid == 0) return auction.reservePrice;

        uint256 minimum = currentBid + (currentBid * auction.minBidIncrementBps) / BPS_DENOMINATOR;
        return minimum == currentBid ? currentBid + 1 : minimum;
    }

    /*//////////////////////////////////////////////////////////////
                             ASSET RECEIVER
    //////////////////////////////////////////////////////////////*/

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC165, IERC165) returns (bool) {
        return interfaceId == type(IERC721Receiver).interfaceId
            || interfaceId == type(IERC1155Receiver).interfaceId || super.supportsInterface(interfaceId);
    }
}
