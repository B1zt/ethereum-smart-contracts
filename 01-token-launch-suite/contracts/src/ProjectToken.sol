// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

/// @title ProjectToken
/// @notice Governance and utility token: capped supply, gasless approvals, and on-chain voting power.
///
/// @dev Three extensions, each earning its place:
///
///      - **ERC20Permit (EIP-2612)** lets a holder approve by signature. Without it every first
///        interaction with a staking or vesting contract costs two transactions, and the approve
///        step is where most users drop out.
///
///      - **ERC20Votes** snapshots voting power per block, which is what makes governance safe
///        against flash-loan voting: a proposal counts the balance you held when it was created,
///        not the balance you borrowed to vote with.
///
///      - **Capped supply**, enforced in `mint` and immutable after deployment. A token whose
///        supply the owner can inflate without limit is the single most common rug vector, and
///        "trust us" is not a supply cap.
///
///      Minting is behind a role rather than an owner so it can be handed to a staking contract or
///      an emissions schedule without also handing over every other admin power.
contract ProjectToken is ERC20, ERC20Burnable, ERC20Permit, ERC20Votes, AccessControl {
    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error CapExceeded(uint256 requested, uint256 remaining);
    error ZeroCap();
    error ZeroAddress();
    error MintingAlreadyFinished();

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event MintingFinished();

    /*//////////////////////////////////////////////////////////////
                                 ROLES
    //////////////////////////////////////////////////////////////*/

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Hard supply cap. Immutable, so no admin action can raise it.
    uint256 public immutable cap;

    /// @notice Once true, no token can ever be minted again, whatever roles exist.
    bool public mintingFinished;

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @param name_ Token name.
    /// @param symbol_ Token symbol.
    /// @param cap_ Immutable maximum supply.
    /// @param initialSupply Minted to `treasury` at deployment. Must not exceed the cap.
    /// @param treasury Recipient of the initial supply.
    /// @param admin Holder of `DEFAULT_ADMIN_ROLE`. Should be a timelock or multisig.
    constructor(
        string memory name_,
        string memory symbol_,
        uint256 cap_,
        uint256 initialSupply,
        address treasury,
        address admin
    ) ERC20(name_, symbol_) ERC20Permit(name_) {
        if (cap_ == 0) revert ZeroCap();
        if (treasury == address(0) || admin == address(0)) revert ZeroAddress();
        if (initialSupply > cap_) revert CapExceeded(initialSupply, cap_);

        cap = cap_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);

        if (initialSupply > 0) {
            _mint(treasury, initialSupply);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                MINTING
    //////////////////////////////////////////////////////////////*/

    /// @notice Mint new tokens, bounded by the cap.
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        if (mintingFinished) revert MintingAlreadyFinished();

        uint256 supply = totalSupply();
        if (supply + amount > cap) revert CapExceeded(amount, cap - supply);

        _mint(to, amount);
    }

    /// @notice Permanently disable minting.
    /// @dev One-way, and stronger than revoking the role: a role can be granted again, this cannot
    ///      be undone. This is the switch a project flips once distribution is complete.
    function finishMinting() external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (mintingFinished) revert MintingAlreadyFinished();

        mintingFinished = true;
        emit MintingFinished();
    }

    /// @notice Tokens that may still be minted.
    function remainingMintable() external view returns (uint256) {
        if (mintingFinished) return 0;
        return cap - totalSupply();
    }

    /*//////////////////////////////////////////////////////////////
                          REQUIRED OVERRIDES
    //////////////////////////////////////////////////////////////*/

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
        super._update(from, to, value);
    }

    function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }

    /// @notice Voting power is tracked against wall-clock time rather than block numbers.
    /// @dev Block times are not constant, so a governance period measured in blocks silently
    ///      changes length whenever block production does. Timestamps keep "3 days" meaning 3 days.
    function clock() public view override returns (uint48) {
        return uint48(block.timestamp);
    }

    /// @notice ERC-6372 clock description, so Governor implementations detect the mode correctly.
    function CLOCK_MODE() public pure override returns (string memory) {
        return "mode=timestamp";
    }
}
