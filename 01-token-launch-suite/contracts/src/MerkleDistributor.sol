// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @title MerkleDistributor
/// @notice Airdrop claims against a Merkle root, with claim state packed into a bitmap.
///
/// @dev The bitmap is the reason this is cheap at scale. A `mapping(uint256 => bool)` costs a fresh
///      20,000 gas storage slot per claimant forever. Packing 256 claims into one word means the
///      first claimant in a word pays for the slot and the next 255 pay 5,000 gas to update it.
///      Across a 10,000 address airdrop that is roughly 150M gas saved, paid by users rather than
///      the project, which is exactly where a saving is least visible and most appreciated.
///
///      Leaves commit to `(index, account, amount)`. The index is what makes the bitmap possible;
///      the account binds the claim to a specific wallet so a proof cannot be front-run by someone
///      else submitting it for their own address.
contract MerkleDistributor is Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error AlreadyClaimed(uint256 index);
    error InvalidProof();
    error ClaimWindowClosed(uint256 deadline);
    error ClaimWindowStillOpen(uint256 deadline);
    error ZeroAddress();
    error NothingToSweep();
    error LengthMismatch();

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event Claimed(uint256 indexed index, address indexed account, uint256 amount);
    event Swept(address indexed to, uint256 amount);

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    IERC20 public immutable token;

    /// @notice Root committing to every `(index, account, amount)` triple.
    bytes32 public immutable merkleRoot;

    /// @notice After this, unclaimed tokens can be swept back.
    /// @dev A deadline is not hostile: without one, a meaningful fraction of any airdrop is stranded
    ///      forever in wallets that will never claim. It is published up front and immutable.
    uint256 public immutable claimDeadline;

    /// @dev 256 claims per word. Word index is `index / 256`, bit position is `index % 256`.
    mapping(uint256 word => uint256 bits) private _claimedBitMap;

    /// @notice Total claimed so far, for progress reporting.
    uint256 public totalClaimed;

    /// @notice Number of successful claims.
    uint256 public claimCount;

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(IERC20 token_, bytes32 merkleRoot_, uint256 claimDeadline_, address owner_) Ownable(owner_) {
        if (address(token_) == address(0)) revert ZeroAddress();

        token = token_;
        merkleRoot = merkleRoot_;
        claimDeadline = claimDeadline_;
    }

    /*//////////////////////////////////////////////////////////////
                                CLAIMING
    //////////////////////////////////////////////////////////////*/

    /// @notice Claim an allocation.
    /// @dev Permissionless in who submits it, but the tokens always go to `account`. That allows a
    ///      project to pay gas on a user's behalf without being able to redirect their allocation.
    function claim(uint256 index, address account, uint256 amount, bytes32[] calldata proof)
        public
        nonReentrant
    {
        if (block.timestamp > claimDeadline) revert ClaimWindowClosed(claimDeadline);
        if (isClaimed(index)) revert AlreadyClaimed(index);

        // Double hashed, so a 64-byte internal node can never be presented as a leaf.
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))));
        if (!MerkleProof.verifyCalldata(proof, merkleRoot, leaf)) revert InvalidProof();

        _setClaimed(index);

        totalClaimed += amount;
        unchecked {
            ++claimCount;
        }

        token.safeTransfer(account, amount);

        emit Claimed(index, account, amount);
    }

    /// @notice Claim several allocations in one transaction.
    /// @dev Useful for a relayer processing a batch on users' behalf.
    function claimMany(
        uint256[] calldata indices,
        address[] calldata accounts,
        uint256[] calldata amounts,
        bytes32[][] calldata proofs
    ) external {
        if (
            indices.length != accounts.length || indices.length != amounts.length
                || indices.length != proofs.length
        ) {
            revert LengthMismatch();
        }

        for (uint256 i; i < indices.length; ++i) {
            claim(indices[i], accounts[i], amounts[i], proofs[i]);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                 BITMAP
    //////////////////////////////////////////////////////////////*/

    /// @notice Whether an index has been claimed.
    function isClaimed(uint256 index) public view returns (bool) {
        uint256 wordIndex = index / 256;
        uint256 bitIndex = index % 256;

        // The lint flags a literal on the left of a shift as a likely swapped-argument bug. Here it
        // is deliberate: shifting 1 left by the bit position is how the mask is built.
        // forge-lint: disable-next-line(incorrect-shift)
        return _claimedBitMap[wordIndex] & (1 << bitIndex) != 0;
    }

    function _setClaimed(uint256 index) private {
        uint256 wordIndex = index / 256;
        uint256 bitIndex = index % 256;

        // forge-lint: disable-next-line(incorrect-shift)
        _claimedBitMap[wordIndex] |= (1 << bitIndex);
    }

    /// @notice Raw bitmap word, so a frontend can check 256 claims in a single call.
    function claimedBitMap(uint256 wordIndex) external view returns (uint256) {
        return _claimedBitMap[wordIndex];
    }

    /*//////////////////////////////////////////////////////////////
                                 SWEEP
    //////////////////////////////////////////////////////////////*/

    /// @notice Recover unclaimed tokens once the window has closed.
    function sweep(address to) external onlyOwner {
        if (block.timestamp <= claimDeadline) revert ClaimWindowStillOpen(claimDeadline);
        if (to == address(0)) revert ZeroAddress();

        uint256 balance = token.balanceOf(address(this));
        if (balance == 0) revert NothingToSweep();

        token.safeTransfer(to, balance);
        emit Swept(to, balance);
    }

    /// @notice Recover an unrelated token sent here by mistake.
    /// @dev Not gated on the deadline, because these were never part of the airdrop. The airdrop
    ///      token itself is excluded so this cannot become a back door around the window.
    function sweepOther(IERC20 other, address to) external onlyOwner {
        if (address(other) == address(token)) revert NothingToSweep();
        if (to == address(0)) revert ZeroAddress();

        uint256 balance = other.balanceOf(address(this));
        if (balance == 0) revert NothingToSweep();

        other.safeTransfer(to, balance);
    }

    /// @notice Seconds until the claim window closes, or zero once it has.
    function timeRemaining() external view returns (uint256) {
        if (block.timestamp >= claimDeadline) return 0;
        return claimDeadline - block.timestamp;
    }
}
