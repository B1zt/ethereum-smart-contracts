// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20, IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title StakingVault
/// @notice ERC-4626 staking vault. Stake the token, receive shares, rewards accrue to every share.
///
/// @dev **Why ERC-4626 rather than a rewards-per-token accumulator.** In a share-based vault,
///      distributing rewards means transferring tokens in and doing nothing else: total assets rise,
///      so every share is worth more. There is no per-user reward bookkeeping to update, no dust
///      left behind, and the share token composes with anything that speaks ERC-4626.
///
///      **The inflation attack.** The classic ERC-4626 exploit: a first depositor mints 1 wei of
///      shares, donates a large amount directly to the vault, and the next depositor's deposit
///      rounds down to zero shares, handing their tokens to the attacker. OpenZeppelin's v5 ERC4626
///      defends with virtual shares and assets, which makes the attack cost grow faster than the
///      profit. `_decimalsOffset` is raised to 6 here, which turns an already-unprofitable attack
///      into an absurd one.
///
///      **Reward streaming.** Rewards are released linearly over a configured window rather than
///      landing all at once. A lump sum lets someone deposit in the same block the reward arrives,
///      capture a share of it, and leave, which dilutes everyone who was staked the whole time.
contract StakingVault is ERC4626, Ownable2Step {
    using SafeERC20 for IERC20;
    using Math for uint256;

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error ZeroAddress();
    error ZeroAmount();
    error ZeroDuration();
    error StillCoolingDown(uint256 unlocksAt);
    error CooldownTooLong(uint64 seconds_);

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event RewardsAdded(uint256 amount, uint256 finishAt);
    event RewardDurationUpdated(uint64 duration);
    event CooldownUpdated(uint64 cooldown);

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Upper bound on the withdrawal cooldown, so an owner cannot lock stakers in forever.
    uint64 public constant MAX_COOLDOWN = 30 days;

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Rewards not yet streamed into `totalAssets`.
    uint256 public pendingRewards;

    /// @notice When the current reward stream finishes.
    uint64 public rewardsFinishAt;

    /// @notice When the current reward stream was last accounted for.
    uint64 public lastRewardUpdate;

    /// @notice How long each reward deposit streams over.
    uint64 public rewardDuration;

    /// @notice Delay between the last deposit and being allowed to withdraw.
    /// @dev Optional. Set to zero for an unlocked vault.
    uint64 public cooldown;

    /// @notice Earliest withdrawal time per account.
    mapping(address account => uint64 unlocksAt) public unlocksAt;

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(IERC20 asset_, string memory name_, string memory symbol_, uint64 rewardDuration_, address owner_)
        ERC4626(asset_)
        ERC20(name_, symbol_)
        Ownable(owner_)
    {
        if (address(asset_) == address(0)) revert ZeroAddress();
        if (rewardDuration_ == 0) revert ZeroDuration();

        rewardDuration = rewardDuration_;
        lastRewardUpdate = uint64(block.timestamp);
    }

    /*//////////////////////////////////////////////////////////////
                             REWARD STREAM
    //////////////////////////////////////////////////////////////*/

    /// @notice Fund the vault with rewards, streamed linearly from now.
    /// @dev Adding to a stream that is still running extends it: the unstreamed remainder is folded
    ///      into the new amount and the whole thing restarts over `rewardDuration`. That is the
    ///      standard behaviour and it avoids leaving orphaned partial streams behind.
    function notifyRewardAmount(uint256 amount) external onlyOwner {
        if (amount == 0) revert ZeroAmount();

        _streamRewards();

        pendingRewards += amount;
        lastRewardUpdate = uint64(block.timestamp);
        rewardsFinishAt = uint64(block.timestamp) + rewardDuration;

        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);

        emit RewardsAdded(amount, rewardsFinishAt);
    }

    /// @dev Moves the elapsed portion of the stream out of `pendingRewards`, which is what makes it
    ///      count towards `totalAssets`.
    function _streamRewards() private {
        uint256 released = _streamedSinceLastUpdate();
        if (released > 0) {
            pendingRewards -= released;
            lastRewardUpdate = uint64(block.timestamp);
        }
    }

    function _streamedSinceLastUpdate() private view returns (uint256) {
        uint256 pending = pendingRewards;
        if (pending == 0) return 0;

        uint64 finish = rewardsFinishAt;
        uint64 last = lastRewardUpdate;

        if (block.timestamp >= finish) return pending;
        if (block.timestamp <= last) return 0;

        uint256 elapsed = block.timestamp - last;
        uint256 remaining = finish - last;

        return (pending * elapsed) / remaining;
    }

    /// @notice Rewards still locked in the stream and not yet counted as vault assets.
    function lockedRewards() public view returns (uint256) {
        return pendingRewards - _streamedSinceLastUpdate();
    }

    /*//////////////////////////////////////////////////////////////
                            ERC-4626 CORE
    //////////////////////////////////////////////////////////////*/

    /// @notice Assets backing the shares, excluding rewards that have not streamed yet.
    /// @dev Excluding the locked portion is the whole mechanism. If the full reward counted
    ///      immediately, a depositor could enter in the same block it arrived, take a share of it,
    ///      and leave, diluting everyone who had actually been staked.
    function totalAssets() public view override returns (uint256) {
        return IERC20(asset()).balanceOf(address(this)) - lockedRewards();
    }

    /// @notice Extra virtual decimals used in share conversion.
    /// @dev Raising this to 6 makes the classic ERC-4626 first-depositor inflation attack cost
    ///      roughly a million times more than it could ever return.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    /*//////////////////////////////////////////////////////////////
                           DEPOSIT AND WITHDRAW
    //////////////////////////////////////////////////////////////*/

    /// @dev Streaming is settled before every deposit and withdrawal so the share price used for
    ///      conversion is always current. Without this, a depositor entering just before a large
    ///      stream tick would get shares priced on stale assets.
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        _streamRewards();

        if (cooldown > 0) {
            unlocksAt[receiver] = uint64(block.timestamp) + cooldown;
        }

        super._deposit(caller, receiver, assets, shares);
    }

    function _withdraw(address caller, address receiver, address owner_, uint256 assets, uint256 shares)
        internal
        override
    {
        _streamRewards();

        uint64 unlockTime = unlocksAt[owner_];
        if (unlockTime > block.timestamp) revert StillCoolingDown(unlockTime);

        super._withdraw(caller, receiver, owner_, assets, shares);
    }

    /*//////////////////////////////////////////////////////////////
                                 ADMIN
    //////////////////////////////////////////////////////////////*/

    function setRewardDuration(uint64 duration) external onlyOwner {
        if (duration == 0) revert ZeroDuration();

        // Settle first, so the change applies only to what has not streamed yet.
        _streamRewards();

        rewardDuration = duration;
        emit RewardDurationUpdated(duration);
    }

    function setCooldown(uint64 cooldown_) external onlyOwner {
        if (cooldown_ > MAX_COOLDOWN) revert CooldownTooLong(cooldown_);

        cooldown = cooldown_;
        emit CooldownUpdated(cooldown_);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice Assets one full share is currently worth, scaled to the asset's decimals.
    function pricePerShare() external view returns (uint256) {
        return convertToAssets(10 ** decimals());
    }

    /// @notice Annualised percentage yield in basis points, from the current stream rate.
    /// @dev A projection, not a promise. It assumes the current rate continues for a year and that
    ///      total assets stay put, neither of which is guaranteed.
    function currentApr() external view returns (uint256) {
        uint256 assets = totalAssets();
        if (assets == 0) return 0;

        uint64 finish = rewardsFinishAt;
        if (block.timestamp >= finish) return 0;

        uint256 remaining = lockedRewards();
        uint256 secondsLeft = finish - block.timestamp;
        if (secondsLeft == 0) return 0;

        uint256 perYear = (remaining * 365 days) / secondsLeft;
        return (perYear * 10_000) / assets;
    }

    /// @notice Seconds until an account may withdraw, or zero if it already can.
    function cooldownRemaining(address account) external view returns (uint256) {
        uint64 unlockTime = unlocksAt[account];
        if (unlockTime <= block.timestamp) return 0;

        return unlockTime - block.timestamp;
    }
}
