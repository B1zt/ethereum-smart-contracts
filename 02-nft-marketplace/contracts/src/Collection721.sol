// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721A} from "erc721a/contracts/ERC721A.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title Collection721
/// @notice Gas-optimised ERC-721 collection with multi-phase minting, Merkle allowlists,
///         a delayed reveal backed by a provenance hash, and EIP-2981 royalties.
/// @dev Built on ERC721A so that batch mints cost roughly one storage write regardless of
///      quantity. Token ids start at 1 because most marketplaces and indexers assume it.
///
///      Mint phases are fully configurable after deployment, which is what makes this
///      reusable across drops: a launch can run a free team phase, a Merkle allowlist phase
///      with per-address allowances, and an open public phase without redeploying.
contract Collection721 is ERC721A, ERC2981, Ownable2Step {
    using Strings for uint256;

    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    /// @notice Configuration for a single mint phase.
    /// @dev Packed into two slots. `merkleRoot` occupies the first, the rest share the second.
    struct Phase {
        /// @dev Allowlist root. Leaves are keccak256(bytes.concat(keccak256(abi.encode(account, allowance)))).
        ///      A zero root marks the phase as public, in which case `maxPerWallet` is the only cap.
        bytes32 merkleRoot;
        /// @dev Price per token in wei. Zero is valid (free mint).
        uint96 price;
        /// @dev Inclusive start timestamp.
        uint64 startTime;
        /// @dev Exclusive end timestamp.
        uint64 endTime;
        /// @dev Per-wallet cap for public phases. Ignored when `merkleRoot` is set, since the
        ///      allowance encoded in the leaf takes over.
        uint16 maxPerWallet;
        /// @dev Cap on tokens mintable in this phase. Zero means "bounded only by maxSupply".
        uint16 maxSupply;
    }

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error PhaseDoesNotExist(uint256 phaseId);
    error PhaseNotActive(uint256 phaseId);
    error InvalidPhaseWindow();
    error ZeroQuantity();
    error ExceedsMaxSupply(uint256 requested, uint256 remaining);
    error ExceedsPhaseSupply(uint256 requested, uint256 remaining);
    error ExceedsWalletAllowance(uint256 requested, uint256 remaining);
    error IncorrectPayment(uint256 sent, uint256 expected);
    error InvalidProof();
    error ProofNotRequired();
    error AlreadyRevealed();
    error ProvenanceAlreadyLocked();
    error NothingToWithdraw();
    error WithdrawFailed();
    error ZeroAddress();
    error RoyaltyTooHigh(uint96 bps);

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event PhaseSet(uint256 indexed phaseId, Phase phase);
    event PhaseRemoved(uint256 indexed phaseId);
    event Minted(address indexed to, uint256 indexed phaseId, uint256 quantity, uint256 startTokenId, uint256 paid);
    event Revealed(string baseURI);
    event ProvenanceHashSet(bytes32 provenanceHash);
    event TreasuryUpdated(address indexed treasury);
    event Withdrawn(address indexed treasury, uint256 amount);

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Hard cap on the total number of tokens that can ever exist.
    uint256 public immutable maxSupply;

    /// @notice Maximum royalty the owner is allowed to set, in basis points (10%).
    uint96 public constant MAX_ROYALTY_BPS = 1_000;

    /// @notice Configured mint phases, indexed by phase id.
    Phase[] private _phases;

    /// @notice Tokens minted per phase.
    mapping(uint256 phaseId => uint256 minted) public phaseMinted;

    /// @notice Tokens minted per wallet per phase.
    mapping(uint256 phaseId => mapping(address wallet => uint256 minted)) public walletMinted;

    /// @notice Destination for mint proceeds.
    address public treasury;

    /// @notice Metadata base URI, only meaningful once `revealed` is true.
    string private _baseTokenURI;

    /// @notice Placeholder URI served for every token before reveal.
    string private _unrevealedURI;

    /// @notice Whether the real metadata has been published.
    bool public revealed;

    /// @notice Hash committing to the final image order, published before minting opens.
    /// @dev Locked permanently once set, so buyers can verify the collection was not reordered.
    bytes32 public provenanceHash;

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @param name_ Collection name.
    /// @param symbol_ Collection symbol.
    /// @param maxSupply_ Hard supply cap.
    /// @param unrevealedURI_ Placeholder metadata URI used before reveal.
    /// @param treasury_ Address that receives mint proceeds.
    /// @param royaltyReceiver_ EIP-2981 royalty recipient.
    /// @param royaltyBps_ EIP-2981 royalty in basis points, capped at `MAX_ROYALTY_BPS`.
    /// @param owner_ Initial owner. Should be a multisig in production.
    constructor(
        string memory name_,
        string memory symbol_,
        uint256 maxSupply_,
        string memory unrevealedURI_,
        address treasury_,
        address royaltyReceiver_,
        uint96 royaltyBps_,
        address owner_
    ) ERC721A(name_, symbol_) Ownable(owner_) {
        if (maxSupply_ == 0) revert ZeroQuantity();
        if (treasury_ == address(0) || royaltyReceiver_ == address(0)) revert ZeroAddress();
        if (royaltyBps_ > MAX_ROYALTY_BPS) revert RoyaltyTooHigh(royaltyBps_);

        maxSupply = maxSupply_;
        _unrevealedURI = unrevealedURI_;
        treasury = treasury_;
        _setDefaultRoyalty(royaltyReceiver_, royaltyBps_);

        emit TreasuryUpdated(treasury_);
    }

    /*//////////////////////////////////////////////////////////////
                                MINTING
    //////////////////////////////////////////////////////////////*/

    /// @notice Mint from a configured phase.
    /// @param phaseId Index of the phase to mint from.
    /// @param quantity Number of tokens to mint.
    /// @param allowance Per-wallet allowance encoded in the Merkle leaf. Ignored for public phases.
    /// @param proof Merkle proof for `(msg.sender, allowance)`. Must be empty for public phases.
    function mint(uint256 phaseId, uint256 quantity, uint256 allowance, bytes32[] calldata proof)
        external
        payable
    {
        if (phaseId >= _phases.length) revert PhaseDoesNotExist(phaseId);
        if (quantity == 0) revert ZeroQuantity();

        Phase memory phase = _phases[phaseId];
        if (block.timestamp < phase.startTime || block.timestamp >= phase.endTime) {
            revert PhaseNotActive(phaseId);
        }

        uint256 walletCap = _verifyEligibility(phase, allowance, proof);

        // Wallet cap.
        uint256 mintedByWallet = walletMinted[phaseId][msg.sender];
        if (mintedByWallet + quantity > walletCap) {
            revert ExceedsWalletAllowance(quantity, walletCap - mintedByWallet);
        }

        // Phase cap. A zero `maxSupply` on the phase means it is bounded only by the global cap.
        if (phase.maxSupply != 0) {
            uint256 mintedInPhase = phaseMinted[phaseId];
            if (mintedInPhase + quantity > phase.maxSupply) {
                revert ExceedsPhaseSupply(quantity, phase.maxSupply - mintedInPhase);
            }
        }

        // Global cap.
        uint256 supply = _totalMinted();
        if (supply + quantity > maxSupply) revert ExceedsMaxSupply(quantity, maxSupply - supply);

        // Exact payment only. Refunding change would add a reentrancy surface for no real benefit,
        // and every wallet computes the price from the same on-chain phase config anyway.
        uint256 cost = uint256(phase.price) * quantity;
        if (msg.value != cost) revert IncorrectPayment(msg.value, cost);

        unchecked {
            walletMinted[phaseId][msg.sender] = mintedByWallet + quantity;
            phaseMinted[phaseId] += quantity;
        }

        uint256 startTokenId = _nextTokenId();
        _mint(msg.sender, quantity);

        emit Minted(msg.sender, phaseId, quantity, startTokenId, cost);
    }

    /// @notice Mint without payment or phase checks, for team reserves and giveaways.
    /// @dev Still bounded by `maxSupply`. Deliberately not restricted to a phase so the owner can
    ///      reserve tokens before the public sale opens.
    function ownerMint(address to, uint256 quantity) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (quantity == 0) revert ZeroQuantity();

        uint256 supply = _totalMinted();
        if (supply + quantity > maxSupply) revert ExceedsMaxSupply(quantity, maxSupply - supply);

        uint256 startTokenId = _nextTokenId();
        _mint(to, quantity);

        emit Minted(to, type(uint256).max, quantity, startTokenId, 0);
    }

    /// @dev Resolves the effective per-wallet cap for a phase and validates any Merkle proof.
    function _verifyEligibility(Phase memory phase, uint256 allowance, bytes32[] calldata proof)
        private
        view
        returns (uint256 walletCap)
    {
        if (phase.merkleRoot == bytes32(0)) {
            // Public phase. A proof would be meaningless here, so reject it rather than silently
            // ignoring it, which would hide integration bugs on the frontend.
            if (proof.length != 0) revert ProofNotRequired();
            return phase.maxPerWallet;
        }

        // Double hashing the leaf makes second-preimage attacks against internal nodes infeasible.
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, allowance))));
        if (!MerkleProof.verifyCalldata(proof, phase.merkleRoot, leaf)) revert InvalidProof();

        return allowance;
    }

    /*//////////////////////////////////////////////////////////////
                            PHASE MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    /// @notice Append a new mint phase.
    /// @return phaseId Index of the newly created phase.
    function addPhase(Phase calldata phase) external onlyOwner returns (uint256 phaseId) {
        _validatePhase(phase);
        phaseId = _phases.length;
        _phases.push(phase);
        emit PhaseSet(phaseId, phase);
    }

    /// @notice Overwrite an existing phase.
    /// @dev Counters are intentionally preserved so an owner cannot reset per-wallet limits by
    ///      editing a live phase.
    function setPhase(uint256 phaseId, Phase calldata phase) external onlyOwner {
        if (phaseId >= _phases.length) revert PhaseDoesNotExist(phaseId);
        _validatePhase(phase);
        _phases[phaseId] = phase;
        emit PhaseSet(phaseId, phase);
    }

    /// @notice Remove the most recently added phase.
    function popPhase() external onlyOwner {
        uint256 phaseId = _phases.length;
        if (phaseId == 0) revert PhaseDoesNotExist(0);
        unchecked {
            --phaseId;
        }
        _phases.pop();
        emit PhaseRemoved(phaseId);
    }

    function _validatePhase(Phase calldata phase) private pure {
        if (phase.startTime >= phase.endTime) revert InvalidPhaseWindow();
        // A public phase with no per-wallet cap would let one buyer take the whole drop.
        if (phase.merkleRoot == bytes32(0) && phase.maxPerWallet == 0) revert InvalidPhaseWindow();
    }

    /// @notice Number of configured phases.
    function phaseCount() external view returns (uint256) {
        return _phases.length;
    }

    /// @notice Read a phase configuration.
    function phases(uint256 phaseId) external view returns (Phase memory) {
        if (phaseId >= _phases.length) revert PhaseDoesNotExist(phaseId);
        return _phases[phaseId];
    }

    /*//////////////////////////////////////////////////////////////
                                METADATA
    //////////////////////////////////////////////////////////////*/

    /// @notice Commit to the final image order before the sale opens.
    /// @dev Write-once. Buyers hash the concatenated image hashes and compare against this value
    ///      to prove the collection was not reordered after seeing who minted what.
    function setProvenanceHash(bytes32 hash) external onlyOwner {
        if (provenanceHash != bytes32(0)) revert ProvenanceAlreadyLocked();
        provenanceHash = hash;
        emit ProvenanceHashSet(hash);
    }

    /// @notice Publish the real metadata. One-way.
    function reveal(string calldata baseURI_) external onlyOwner {
        if (revealed) revert AlreadyRevealed();
        revealed = true;
        _baseTokenURI = baseURI_;
        emit Revealed(baseURI_);
    }

    /// @notice Update the placeholder URI served before reveal.
    function setUnrevealedURI(string calldata uri) external onlyOwner {
        if (revealed) revert AlreadyRevealed();
        _unrevealedURI = uri;
    }

    /// @notice Metadata URI for a token. Serves the placeholder until {reveal} is called.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        if (!_exists(tokenId)) revert URIQueryForNonexistentToken();
        if (!revealed) return _unrevealedURI;
        return string.concat(_baseTokenURI, tokenId.toString(), ".json");
    }

    function _startTokenId() internal pure override returns (uint256) {
        return 1;
    }

    /*//////////////////////////////////////////////////////////////
                          ROYALTIES AND FUNDS
    //////////////////////////////////////////////////////////////*/

    /// @notice Update the default EIP-2981 royalty.
    function setDefaultRoyalty(address receiver, uint96 bps) external onlyOwner {
        if (receiver == address(0)) revert ZeroAddress();
        if (bps > MAX_ROYALTY_BPS) revert RoyaltyTooHigh(bps);
        _setDefaultRoyalty(receiver, bps);
    }

    /// @notice Update the mint proceeds destination.
    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    /// @notice Send the full balance to the treasury.
    /// @dev Permissionless on purpose. The destination is owner-controlled, so letting anyone
    ///      trigger the push costs nothing and keeps funds moving if the owner key is cold.
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

    /// @notice ERC-165 support, covering ERC-721, its metadata extension and EIP-2981.
    function supportsInterface(bytes4 interfaceId) public view override(ERC721A, ERC2981) returns (bool) {
        return ERC721A.supportsInterface(interfaceId) || ERC2981.supportsInterface(interfaceId);
    }

    /// @notice Total number of tokens ever minted, including burned ones.
    function totalMinted() external view returns (uint256) {
        return _totalMinted();
    }

    /// @notice Number of tokens still available under the global cap.
    function remainingSupply() external view returns (uint256) {
        return maxSupply - _totalMinted();
    }
}
