// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @title PaymentSettler
/// @notice Shared settlement logic for trading venues: splits a sale price into protocol fee,
///         creator royalty and seller proceeds, and pays each party out safely.
///
/// @dev Both {Marketplace} and {EnglishAuction} settle trades identically once a price is agreed,
///      so the money path lives here rather than being written twice. Two properties matter:
///
///      1. **Untrusted royalty data.** `royaltyInfo` is a call into the collection, which anyone
///         can deploy. It may revert, return nonsense, or claim a 100% royalty. Every response is
///         treated as hostile: the call is wrapped, the interface is probed first, and the result
///         is capped at {MAX_ROYALTY_BPS}.
///
///      2. **Payouts cannot brick a trade.** A recipient that reverts on receiving ETH would
///         otherwise make every sale involving them permanently unfillable. Failed native pushes
///         become a withdrawable credit instead.
abstract contract PaymentSettler is Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error FeeTooHigh(uint96 bps);
    error ZeroAddress();
    error NothingToWithdraw();
    error TransferFailed();

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event ProtocolFeeUpdated(uint96 bps, address indexed recipient);
    event PaymentEscrowed(address indexed recipient, uint256 amount);
    event EscrowWithdrawn(address indexed recipient, uint256 amount);
    event SaleSettled(
        address indexed collection,
        uint256 indexed tokenId,
        address indexed seller,
        uint256 price,
        uint256 protocolFee,
        address royaltyRecipient,
        uint256 royalty
    );

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    uint256 internal constant BPS_DENOMINATOR = 10_000;

    /// @notice Hard ceiling on the protocol fee. The owner cannot exceed it, ever.
    uint96 public constant MAX_PROTOCOL_FEE_BPS = 1_000;

    /// @notice Hard ceiling on the royalty honoured for any collection.
    uint256 public constant MAX_ROYALTY_BPS = 1_000;

    /// @dev Enough gas for a normal `receive` hook, not enough to do anything interesting with it.
    uint256 internal constant NATIVE_PUSH_GAS = 30_000;

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    uint96 public protocolFeeBps;
    address public protocolFeeRecipient;

    /// @notice Pull-payment balances for recipients whose push transfer failed.
    mapping(address recipient => uint256 amount) public escrowedBalance;

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(address protocolFeeRecipient_, uint96 protocolFeeBps_) {
        _setProtocolFee(protocolFeeRecipient_, protocolFeeBps_);
    }

    /*//////////////////////////////////////////////////////////////
                              SETTLEMENT
    //////////////////////////////////////////////////////////////*/

    /// @notice Split `price` three ways and pay everyone out.
    /// @param currency Payment token, or address(0) for native ETH.
    /// @param payer Address funds are pulled from. Ignored when `fundsHeldByContract` is true.
    /// @param seller Receives whatever remains after fee and royalty.
    /// @param collection NFT contract, queried for EIP-2981 royalty data.
    /// @param tokenId Token being sold.
    /// @param price Gross sale price.
    /// @param fundsHeldByContract True when this contract already custodies the funds, which is the
    ///        case for auctions where bids were escrowed. False for direct order fills, where funds
    ///        move straight from the payer to each recipient.
    function _settle(
        address currency,
        address payer,
        address seller,
        address collection,
        uint256 tokenId,
        uint256 price,
        bool fundsHeldByContract
    ) internal {
        uint256 fee = (price * protocolFeeBps) / BPS_DENOMINATOR;
        (address royaltyRecipient, uint256 royalty) = _royaltyInfo(collection, tokenId, price);

        // Fee and royalty are each capped at 10%, so this cannot underflow.
        uint256 sellerProceeds = price - fee - royalty;

        if (currency == address(0)) {
            // Native ETH is already in this contract, either from msg.value on the fill or from
            // the escrowed winning bid.
            if (fee != 0) _payNative(protocolFeeRecipient, fee);
            if (royalty != 0) _payNative(royaltyRecipient, royalty);
            if (sellerProceeds != 0) _payNative(seller, sellerProceeds);
        } else {
            IERC20 token = IERC20(currency);
            if (fee != 0) _payERC20(token, payer, protocolFeeRecipient, fee, fundsHeldByContract);
            if (royalty != 0) _payERC20(token, payer, royaltyRecipient, royalty, fundsHeldByContract);
            if (sellerProceeds != 0) _payERC20(token, payer, seller, sellerProceeds, fundsHeldByContract);
        }

        emit SaleSettled(collection, tokenId, seller, price, fee, royaltyRecipient, royalty);
    }

    /// @dev Reads EIP-2981 data defensively. Any failure means "no royalty" rather than a revert,
    ///      so a broken collection cannot make its own tokens untradeable.
    function _royaltyInfo(address collection, uint256 tokenId, uint256 price)
        internal
        view
        returns (address recipient, uint256 amount)
    {
        if (!ERC165Checker.supportsInterface(collection, type(IERC2981).interfaceId)) {
            return (address(0), 0);
        }

        try IERC2981(collection).royaltyInfo(tokenId, price) returns (address r, uint256 a) {
            if (r == address(0) || a == 0) return (address(0), 0);

            uint256 cap = (price * MAX_ROYALTY_BPS) / BPS_DENOMINATOR;
            return (r, a > cap ? cap : a);
        } catch {
            return (address(0), 0);
        }
    }

    /// @dev Pushes ETH, falling back to a withdrawable credit if the recipient rejects it.
    function _payNative(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount, gas: NATIVE_PUSH_GAS}("");
        if (!ok) {
            escrowedBalance[to] += amount;
            emit PaymentEscrowed(to, amount);
        }
    }

    function _payERC20(IERC20 token, address payer, address to, uint256 amount, bool fundsHeldByContract)
        private
    {
        if (fundsHeldByContract) {
            token.safeTransfer(to, amount);
        } else {
            token.safeTransferFrom(payer, to, amount);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                ESCROW
    //////////////////////////////////////////////////////////////*/

    /// @notice Withdraw ETH that could not be pushed to you at settlement time.
    /// @dev Deliberately never pausable. A pause must not be able to trap user funds.
    function withdrawEscrow() external nonReentrant {
        uint256 amount = escrowedBalance[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        escrowedBalance[msg.sender] = 0;

        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit EscrowWithdrawn(msg.sender, amount);
    }

    /*//////////////////////////////////////////////////////////////
                                 ADMIN
    //////////////////////////////////////////////////////////////*/

    function setProtocolFee(address recipient, uint96 bps) external onlyOwner {
        _setProtocolFee(recipient, bps);
    }

    function _setProtocolFee(address recipient, uint96 bps) private {
        if (recipient == address(0)) revert ZeroAddress();
        if (bps > MAX_PROTOCOL_FEE_BPS) revert FeeTooHigh(bps);

        protocolFeeRecipient = recipient;
        protocolFeeBps = bps;

        emit ProtocolFeeUpdated(bps, recipient);
    }
}
