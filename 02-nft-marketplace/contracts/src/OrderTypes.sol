// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Which side of the trade the order maker is on.
enum Side {
    /// @dev Maker owns the NFT and wants currency. Taker buys.
    Listing,
    /// @dev Maker owns currency and wants the NFT. Taker sells.
    Offer
}

/// @notice Token standard of the asset being traded.
enum TokenType {
    ERC721,
    ERC1155
}

/// @notice A gasless order. Makers sign these off-chain; takers submit them on-chain to trade.
/// @dev Field order is part of the EIP-712 type hash. Changing it is a breaking change for every
///      signature already in the order book, so append rather than reorder.
struct Order {
    /// @dev Signer of the order and the counterparty to the taker.
    address maker;
    /// @dev NFT contract being traded.
    address collection;
    /// @dev Token id. For ERC-1155 this is the id of the edition.
    uint256 tokenId;
    /// @dev Units offered. Always 1 for ERC-721; ERC-1155 orders may be partially filled.
    uint256 amount;
    /// @dev Payment token. address(0) means native ETH, which is only valid for listings.
    address currency;
    /// @dev Total price for the whole `amount`, not per unit.
    uint256 price;
    /// @dev Inclusive timestamp from which the order is fillable.
    uint256 startTime;
    /// @dev Exclusive timestamp after which the order expires.
    uint256 endTime;
    /// @dev Maker-chosen entropy, so two otherwise identical orders hash differently.
    uint256 salt;
    /// @dev Maker's nonce at signing time. Bumping the on-chain nonce invalidates every order
    ///      signed under the old value, which is how "cancel all my orders" works for one gas fee.
    uint256 nonce;
    Side side;
    TokenType tokenType;
}

/// @notice EIP-712 type hashes and hashing helpers for {Order}.
library OrderTypes {
    /// @dev keccak256 of the Order struct type string. Enum members are encoded as uint8.
    bytes32 internal constant ORDER_TYPEHASH = keccak256(
        "Order(address maker,address collection,uint256 tokenId,uint256 amount,address currency,uint256 price,uint256 startTime,uint256 endTime,uint256 salt,uint256 nonce,uint8 side,uint8 tokenType)"
    );

    /// @notice EIP-712 struct hash for an order.
    function hash(Order memory order) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ORDER_TYPEHASH,
                order.maker,
                order.collection,
                order.tokenId,
                order.amount,
                order.currency,
                order.price,
                order.startTime,
                order.endTime,
                order.salt,
                order.nonce,
                uint8(order.side),
                uint8(order.tokenType)
            )
        );
    }
}
