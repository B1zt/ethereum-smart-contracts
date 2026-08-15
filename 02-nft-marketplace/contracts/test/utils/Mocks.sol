// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Marketplace} from "../../src/Marketplace.sol";
import {Order} from "../../src/OrderTypes.sol";

/// @notice Plain ERC-20 with open minting, used as a payment currency in tests.
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Plain ERC-721 with open minting and no royalty support.
contract MockERC721 is ERC721 {
    constructor() ERC721("Mock", "MOCK") {}

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }
}

/// @notice Plain ERC-1155 with open minting, used for partial-fill tests.
contract MockERC1155 is ERC1155 {
    constructor() ERC1155("") {}

    function mint(address to, uint256 id, uint256 amount) external {
        _mint(to, id, amount, "");
    }
}

/// @notice Collection that claims a royalty far above the marketplace cap.
/// @dev Models the "malicious collection drains the seller" attack. The venue must clamp this.
contract GreedyRoyaltyCollection is ERC721, IERC2981 {
    address public immutable recipient;
    uint256 public immutable bps;

    constructor(address recipient_, uint256 bps_) ERC721("Greedy", "GREED") {
        recipient = recipient_;
        bps = bps_;
    }

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }

    function royaltyInfo(uint256, uint256 salePrice) external view returns (address, uint256) {
        return (recipient, (salePrice * bps) / 10_000);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, IERC165) returns (bool) {
        return interfaceId == type(IERC2981).interfaceId || super.supportsInterface(interfaceId);
    }
}

/// @notice Collection whose `royaltyInfo` always reverts.
/// @dev A venue that does not wrap the call would make every token in this collection untradeable.
contract RevertingRoyaltyCollection is ERC721, IERC2981 {
    constructor() ERC721("Reverting", "REV") {}

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }

    function royaltyInfo(uint256, uint256) external pure returns (address, uint256) {
        revert("royaltyInfo: nope");
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, IERC165) returns (bool) {
        return interfaceId == type(IERC2981).interfaceId || super.supportsInterface(interfaceId);
    }
}

/// @notice Address that refuses every incoming ETH transfer.
/// @dev Used to prove failed payouts fall back to escrow instead of reverting the trade.
contract RejectingReceiver {
    receive() external payable {
        revert("no thanks");
    }
}

/// @notice Address that burns all forwarded gas on receive.
/// @dev Proves the capped-gas native push cannot be used to grief a settlement.
contract GasBurningReceiver {
    uint256 public counter;

    receive() external payable {
        while (true) {
            unchecked {
                ++counter;
            }
        }
    }
}

/// @notice EIP-1271 smart contract wallet that validates signatures from a fixed signer key.
contract MockERC1271Wallet is IERC1271 {
    address public immutable signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == signer) {
            return IERC1271.isValidSignature.selector;
        }
        return 0xffffffff;
    }

    /// @dev So the wallet can hold and approve NFTs in tests.
    function execute(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        require(ok, "execute failed");
        return ret;
    }

    receive() external payable {}
}

/// @notice Tries to re-enter the marketplace from an ERC-721 transfer hook.
/// @dev The receiver hook fires while `fulfillListing` is mid-flight, which is exactly the window a
///      reentrancy guard has to close.
contract ReentrantBuyer {
    Marketplace public immutable marketplace;
    Order private _order;
    bytes private _signature;
    bool public attempted;
    bool public reentryReverted;

    constructor(Marketplace marketplace_) {
        marketplace = marketplace_;
    }

    function arm(Order calldata order, bytes calldata signature) external {
        _order = order;
        _signature = signature;
    }

    function buy(Order calldata order, bytes calldata signature) external payable {
        marketplace.fulfillListing{value: msg.value}(order, signature, 1);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        if (!attempted) {
            attempted = true;
            try marketplace.fulfillListing{value: address(this).balance}(_order, _signature, 1) {
                reentryReverted = false;
            } catch {
                reentryReverted = true;
            }
        }
        return this.onERC721Received.selector;
    }

    receive() external payable {}
}
