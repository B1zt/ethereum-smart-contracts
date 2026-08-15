// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155Supply} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title Editions1155
/// @notice Multi-edition drops: one contract, many independently configured editions.
/// @dev The ERC-1155 counterpart to {Collection721}. Where the 721 contract models one drop split
///      into phases, this models many concurrent editions, each with its own supply, price, window
///      and optional allowlist. That is the shape most "open edition" and "membership tier" drops
///      actually need.
contract Editions1155 is ERC1155Supply, ERC2981, Ownable2Step {
    using Strings for uint256;

    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    struct Edition {
        /// @dev Zero root means open to everyone.
        bytes32 merkleRoot;
        /// @dev Price per unit in wei.
        uint96 price;
        /// @dev Inclusive start timestamp.
        uint64 startTime;
        /// @dev Exclusive end timestamp.
        uint64 endTime;
        /// @dev Hard supply cap for this edition. Zero means unlimited (open edition).
        uint128 maxSupply;
        /// @dev Per-wallet cap for open editions. Ignored when a Merkle root is set.
        uint64 maxPerWallet;
        /// @dev Set once the edition exists, so id 0 can still be a valid edition.
        bool exists;
    }

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error EditionDoesNotExist(uint256 id);
    error EditionAlreadyExists(uint256 id);
    error EditionNotActive(uint256 id);
    error InvalidWindow();
    error ZeroQuantity();
    error ExceedsEditionSupply(uint256 requested, uint256 remaining);
    error ExceedsWalletAllowance(uint256 requested, uint256 remaining);
    error IncorrectPayment(uint256 sent, uint256 expected);
    error InvalidProof();
    error ProofNotRequired();
    error LengthMismatch();
    error ZeroAddress();
    error RoyaltyTooHigh(uint96 bps);
    error NothingToWithdraw();
    error WithdrawFailed();
    error MetadataFrozen(uint256 id);

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event EditionCreated(uint256 indexed id, Edition edition, string uri);
    event EditionUpdated(uint256 indexed id, Edition edition);
    event EditionURISet(uint256 indexed id, string uri);
    event EditionMetadataFrozen(uint256 indexed id);
    event Minted(address indexed to, uint256 indexed id, uint256 quantity, uint256 paid);
    event TreasuryUpdated(address indexed treasury);
    event Withdrawn(address indexed treasury, uint256 amount);

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    uint96 public constant MAX_ROYALTY_BPS = 1_000;

    string public name;
    string public symbol;

    mapping(uint256 id => Edition) private _editions;
    mapping(uint256 id => string) private _editionURI;
    mapping(uint256 id => bool) public metadataFrozen;
    mapping(uint256 id => mapping(address wallet => uint256 minted)) public walletMinted;

    address public treasury;

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(
        string memory name_,
        string memory symbol_,
        address treasury_,
        address royaltyReceiver_,
        uint96 royaltyBps_,
        address owner_
    ) ERC1155("") Ownable(owner_) {
        if (treasury_ == address(0) || royaltyReceiver_ == address(0)) revert ZeroAddress();
        if (royaltyBps_ > MAX_ROYALTY_BPS) revert RoyaltyTooHigh(royaltyBps_);

        name = name_;
        symbol = symbol_;
        treasury = treasury_;
        _setDefaultRoyalty(royaltyReceiver_, royaltyBps_);

        emit TreasuryUpdated(treasury_);
    }

    /*//////////////////////////////////////////////////////////////
                            EDITION MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    function createEdition(uint256 id, Edition calldata edition, string calldata uri_) external onlyOwner {
        if (_editions[id].exists) revert EditionAlreadyExists(id);
        _validate(edition);

        Edition memory e = edition;
        e.exists = true;
        _editions[id] = e;
        _editionURI[id] = uri_;

        emit EditionCreated(id, e, uri_);
    }

    /// @notice Update an edition's sale parameters.
    /// @dev Supply already minted is untouched, and `maxSupply` cannot drop below it.
    function updateEdition(uint256 id, Edition calldata edition) external onlyOwner {
        if (!_editions[id].exists) revert EditionDoesNotExist(id);
        _validate(edition);
        if (edition.maxSupply != 0 && edition.maxSupply < totalSupply(id)) {
            revert ExceedsEditionSupply(totalSupply(id), edition.maxSupply);
        }

        Edition memory e = edition;
        e.exists = true;
        _editions[id] = e;

        emit EditionUpdated(id, e);
    }

    function setEditionURI(uint256 id, string calldata uri_) external onlyOwner {
        if (!_editions[id].exists) revert EditionDoesNotExist(id);
        if (metadataFrozen[id]) revert MetadataFrozen(id);

        _editionURI[id] = uri_;
        emit EditionURISet(id, uri_);
        emit URI(uri_, id);
    }

    /// @notice Permanently lock an edition's metadata. One-way, and the strongest signal a creator
    ///         can give that the art will not be swapped out later.
    function freezeMetadata(uint256 id) external onlyOwner {
        if (!_editions[id].exists) revert EditionDoesNotExist(id);
        metadataFrozen[id] = true;
        emit EditionMetadataFrozen(id);
    }

    function _validate(Edition calldata edition) private pure {
        if (edition.startTime >= edition.endTime) revert InvalidWindow();
        // An open edition with neither a supply cap nor a wallet cap has no bound at all.
        if (edition.merkleRoot == bytes32(0) && edition.maxPerWallet == 0) revert InvalidWindow();
    }

    /*//////////////////////////////////////////////////////////////
                                MINTING
    //////////////////////////////////////////////////////////////*/

    function mint(uint256 id, uint256 quantity, uint256 allowance, bytes32[] calldata proof) external payable {
        Edition memory edition = _editions[id];
        if (!edition.exists) revert EditionDoesNotExist(id);
        if (quantity == 0) revert ZeroQuantity();
        if (block.timestamp < edition.startTime || block.timestamp >= edition.endTime) {
            revert EditionNotActive(id);
        }

        uint256 walletCap;
        if (edition.merkleRoot == bytes32(0)) {
            if (proof.length != 0) revert ProofNotRequired();
            walletCap = edition.maxPerWallet;
        } else {
            bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, allowance))));
            if (!MerkleProof.verifyCalldata(proof, edition.merkleRoot, leaf)) revert InvalidProof();
            walletCap = allowance;
        }

        uint256 mintedByWallet = walletMinted[id][msg.sender];
        if (mintedByWallet + quantity > walletCap) {
            revert ExceedsWalletAllowance(quantity, walletCap - mintedByWallet);
        }

        if (edition.maxSupply != 0) {
            uint256 supply = totalSupply(id);
            if (supply + quantity > edition.maxSupply) {
                revert ExceedsEditionSupply(quantity, edition.maxSupply - supply);
            }
        }

        uint256 cost = uint256(edition.price) * quantity;
        if (msg.value != cost) revert IncorrectPayment(msg.value, cost);

        walletMinted[id][msg.sender] = mintedByWallet + quantity;
        _mint(msg.sender, id, quantity, "");

        emit Minted(msg.sender, id, quantity, cost);
    }

    /// @notice Airdrop or reserve units without payment.
    function ownerMint(address[] calldata to, uint256 id, uint256[] calldata quantities) external onlyOwner {
        if (to.length != quantities.length) revert LengthMismatch();

        Edition memory edition = _editions[id];
        if (!edition.exists) revert EditionDoesNotExist(id);

        for (uint256 i; i < to.length; ++i) {
            if (to[i] == address(0)) revert ZeroAddress();
            if (quantities[i] == 0) revert ZeroQuantity();

            if (edition.maxSupply != 0) {
                uint256 supply = totalSupply(id);
                if (supply + quantities[i] > edition.maxSupply) {
                    revert ExceedsEditionSupply(quantities[i], edition.maxSupply - supply);
                }
            }

            _mint(to[i], id, quantities[i], "");
            emit Minted(to[i], id, quantities[i], 0);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                METADATA
    //////////////////////////////////////////////////////////////*/

    /// @notice Per-edition metadata URI.
    /// @dev ERC-1155 allows a single templated URI with an `{id}` placeholder, but per-id storage
    ///      is friendlier to marketplaces that do not implement the substitution correctly.
    function uri(uint256 id) public view override returns (string memory) {
        if (!_editions[id].exists) revert EditionDoesNotExist(id);
        return _editionURI[id];
    }

    function editions(uint256 id) external view returns (Edition memory) {
        if (!_editions[id].exists) revert EditionDoesNotExist(id);
        return _editions[id];
    }

    /*//////////////////////////////////////////////////////////////
                          ROYALTIES AND FUNDS
    //////////////////////////////////////////////////////////////*/

    function setDefaultRoyalty(address receiver, uint96 bps) external onlyOwner {
        if (receiver == address(0)) revert ZeroAddress();
        if (bps > MAX_ROYALTY_BPS) revert RoyaltyTooHigh(bps);
        _setDefaultRoyalty(receiver, bps);
    }

    /// @notice Override the royalty for a single edition.
    function setTokenRoyalty(uint256 id, address receiver, uint96 bps) external onlyOwner {
        if (receiver == address(0)) revert ZeroAddress();
        if (bps > MAX_ROYALTY_BPS) revert RoyaltyTooHigh(bps);
        _setTokenRoyalty(id, receiver, bps);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    function withdraw() external {
        uint256 balance = address(this).balance;
        if (balance == 0) revert NothingToWithdraw();

        address to = treasury;
        (bool ok,) = to.call{value: balance}("");
        if (!ok) revert WithdrawFailed();

        emit Withdrawn(to, balance);
    }

    /*//////////////////////////////////////////////////////////////
                               INTERFACES
    //////////////////////////////////////////////////////////////*/

    function supportsInterface(bytes4 interfaceId) public view override(ERC1155, ERC2981) returns (bool) {
        return ERC1155.supportsInterface(interfaceId) || ERC2981.supportsInterface(interfaceId);
    }
}
