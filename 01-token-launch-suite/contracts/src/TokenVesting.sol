// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @title TokenVesting
/// @notice Linear vesting with a cliff, one schedule per beneficiary per grant.
///
/// @dev The accounting rule that matters: **released tokens are never given back on revocation.**
///      Revoking returns only the unvested remainder to the owner. A beneficiary who has already
///      earned and claimed tokens keeps them, which is the entire point of a vesting contract as
///      opposed to a promise.
///
///      Tokens are pulled in at creation time rather than trusted to be there later. A schedule
///      that exists but is not funded is worse than no schedule: it reads as a commitment while
///      being unenforceable.
contract TokenVesting is Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    struct Schedule {
        address beneficiary;
        /// @dev Total granted over the whole schedule.
        uint128 total;
        /// @dev Claimed so far. Never decreases.
        uint128 released;
        /// @dev Vesting begins here. Nothing vests before it.
        uint64 start;
        /// @dev Seconds after `start` before anything is claimable.
        uint64 cliff;
        /// @dev Total length of the schedule, including the cliff.
        uint64 duration;
        bool revocable;
        bool revoked;
    }

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error ScheduleDoesNotExist(uint256 scheduleId);
    error ZeroAddress();
    error ZeroAmount();
    error ZeroDuration();
    error CliffLongerThanDuration(uint64 cliff, uint64 duration);
    error NothingToRelease();
    error NotRevocable();
    error AlreadyRevoked();
    error LengthMismatch();
    error NothingToSweep();

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event ScheduleCreated(uint256 indexed scheduleId, address indexed beneficiary, Schedule schedule);
    event Released(uint256 indexed scheduleId, address indexed beneficiary, uint256 amount);
    event Revoked(uint256 indexed scheduleId, address indexed beneficiary, uint256 refunded);

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Token being vested. Fixed at deployment so a schedule cannot be repointed later.
    IERC20 public immutable token;

    uint256 public scheduleCount;

    mapping(uint256 scheduleId => Schedule) private _schedules;

    /// @notice Schedule ids per beneficiary, so a UI can enumerate without scanning events.
    mapping(address beneficiary => uint256[] scheduleIds) private _schedulesOf;

    /// @notice Tokens committed to unrevoked schedules and not yet released.
    /// @dev Tracked so `sweep` can only ever move genuinely surplus tokens. Without it, an owner
    ///      could sweep balances that beneficiaries are still owed.
    uint256 public totalCommitted;

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(IERC20 token_, address owner_) Ownable(owner_) {
        if (address(token_) == address(0)) revert ZeroAddress();
        token = token_;
    }

    /*//////////////////////////////////////////////////////////////
                           SCHEDULE CREATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Create and fund a vesting schedule.
    /// @dev Pulls `amount` from the caller, so the owner must have approved this contract first.
    function createSchedule(
        address beneficiary,
        uint128 amount,
        uint64 start,
        uint64 cliff,
        uint64 duration,
        bool revocable
    ) public onlyOwner returns (uint256 scheduleId) {
        if (beneficiary == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (duration == 0) revert ZeroDuration();
        if (cliff > duration) revert CliffLongerThanDuration(cliff, duration);

        scheduleId = scheduleCount++;

        _schedules[scheduleId] = Schedule({
            beneficiary: beneficiary,
            total: amount,
            released: 0,
            start: start,
            cliff: cliff,
            duration: duration,
            revocable: revocable,
            revoked: false
        });

        _schedulesOf[beneficiary].push(scheduleId);
        totalCommitted += amount;

        // Funded up front. A schedule the contract cannot pay out is not a commitment.
        token.safeTransferFrom(msg.sender, address(this), amount);

        emit ScheduleCreated(scheduleId, beneficiary, _schedules[scheduleId]);
    }

    /// @notice Create many schedules in one transaction, for a team or investor round.
    function createSchedules(
        address[] calldata beneficiaries,
        uint128[] calldata amounts,
        uint64 start,
        uint64 cliff,
        uint64 duration,
        bool revocable
    ) external onlyOwner returns (uint256[] memory scheduleIds) {
        if (beneficiaries.length != amounts.length) revert LengthMismatch();

        scheduleIds = new uint256[](beneficiaries.length);
        for (uint256 i; i < beneficiaries.length; ++i) {
            scheduleIds[i] = createSchedule(beneficiaries[i], amounts[i], start, cliff, duration, revocable);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                RELEASE
    //////////////////////////////////////////////////////////////*/

    /// @notice Claim everything vested and unclaimed on a schedule.
    /// @dev Permissionless: anyone may trigger it, but the tokens always go to the beneficiary.
    ///      That lets a project push a distribution for users who never claim, without being able
    ///      to redirect it.
    function release(uint256 scheduleId) public nonReentrant {
        Schedule storage schedule = _schedules[scheduleId];
        if (schedule.beneficiary == address(0)) revert ScheduleDoesNotExist(scheduleId);

        uint256 amount = releasableAmount(scheduleId);
        if (amount == 0) revert NothingToRelease();

        // `amount` is vested minus released, both bounded by `total`, which is already uint128.
        // forge-lint: disable-next-line(unsafe-typecast)
        schedule.released += uint128(amount);
        totalCommitted -= amount;

        token.safeTransfer(schedule.beneficiary, amount);

        emit Released(scheduleId, schedule.beneficiary, amount);
    }

    /// @notice Claim from several schedules at once.
    function releaseMany(uint256[] calldata scheduleIds) external {
        for (uint256 i; i < scheduleIds.length; ++i) {
            release(scheduleIds[i]);
        }
    }

    /*//////////////////////////////////////////////////////////////
                              REVOCATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Cancel the unvested portion of a revocable schedule.
    /// @dev Vested-but-unclaimed tokens are released to the beneficiary first, then the remainder
    ///      returns to the owner. Skipping that first step would let an owner time a revocation to
    ///      confiscate tokens the beneficiary had already earned.
    function revoke(uint256 scheduleId) external onlyOwner nonReentrant {
        Schedule storage schedule = _schedules[scheduleId];
        if (schedule.beneficiary == address(0)) revert ScheduleDoesNotExist(scheduleId);
        if (!schedule.revocable) revert NotRevocable();
        if (schedule.revoked) revert AlreadyRevoked();

        uint256 vested = vestedAmount(scheduleId);
        uint256 releasable = vested - schedule.released;

        if (releasable > 0) {
            // Bounded by `total`, a uint128.
            // forge-lint: disable-next-line(unsafe-typecast)
            schedule.released += uint128(releasable);
            totalCommitted -= releasable;
            token.safeTransfer(schedule.beneficiary, releasable);
            emit Released(scheduleId, schedule.beneficiary, releasable);
        }

        uint256 refund = schedule.total - vested;
        schedule.revoked = true;
        // The schedule is now closed at whatever had vested, so nothing further accrues.
        // `vested` is always <= the previous `total`, a uint128.
        // forge-lint: disable-next-line(unsafe-typecast)
        schedule.total = uint128(vested);

        if (refund > 0) {
            totalCommitted -= refund;
            token.safeTransfer(owner(), refund);
        }

        emit Revoked(scheduleId, schedule.beneficiary, refund);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice Total vested at the current time, claimed or not.
    function vestedAmount(uint256 scheduleId) public view returns (uint256) {
        Schedule memory schedule = _schedules[scheduleId];
        if (schedule.beneficiary == address(0)) revert ScheduleDoesNotExist(scheduleId);

        return _vestedAt(schedule, block.timestamp);
    }

    /// @notice Vested and not yet claimed.
    function releasableAmount(uint256 scheduleId) public view returns (uint256) {
        Schedule memory schedule = _schedules[scheduleId];
        if (schedule.beneficiary == address(0)) revert ScheduleDoesNotExist(scheduleId);

        return _vestedAt(schedule, block.timestamp) - schedule.released;
    }

    /// @notice Vested amount at an arbitrary timestamp, for charting an unlock curve off-chain.
    function vestedAt(uint256 scheduleId, uint256 timestamp) external view returns (uint256) {
        Schedule memory schedule = _schedules[scheduleId];
        if (schedule.beneficiary == address(0)) revert ScheduleDoesNotExist(scheduleId);

        return _vestedAt(schedule, timestamp);
    }

    function _vestedAt(Schedule memory schedule, uint256 timestamp) private pure returns (uint256) {
        // A revoked schedule is frozen: `total` was rewritten to the vested amount at revocation.
        if (schedule.revoked) return schedule.total;

        if (timestamp < schedule.start + schedule.cliff) return 0;
        if (timestamp >= schedule.start + schedule.duration) return schedule.total;

        // Linear from `start`, not from the end of the cliff. Crossing the cliff therefore unlocks
        // everything accrued during it as a single tranche, which is the convention every token
        // unlock chart assumes.
        uint256 elapsed = timestamp - schedule.start;
        return (uint256(schedule.total) * elapsed) / schedule.duration;
    }

    function schedules(uint256 scheduleId) external view returns (Schedule memory) {
        Schedule memory schedule = _schedules[scheduleId];
        if (schedule.beneficiary == address(0)) revert ScheduleDoesNotExist(scheduleId);

        return schedule;
    }

    function schedulesOf(address beneficiary) external view returns (uint256[] memory) {
        return _schedulesOf[beneficiary];
    }

    /// @notice Everything a beneficiary can claim across all their schedules.
    function totalReleasableOf(address beneficiary) external view returns (uint256 total) {
        uint256[] memory ids = _schedulesOf[beneficiary];

        for (uint256 i; i < ids.length; ++i) {
            Schedule memory schedule = _schedules[ids[i]];
            total += _vestedAt(schedule, block.timestamp) - schedule.released;
        }
    }

    /*//////////////////////////////////////////////////////////////
                                 SWEEP
    //////////////////////////////////////////////////////////////*/

    /// @notice Recover tokens that were sent here by mistake.
    /// @dev For the vesting token this is bounded by `totalCommitted`, so it can never touch
    ///      anything a beneficiary is owed. Other tokens have no such claim and move freely.
    function sweep(IERC20 other, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();

        uint256 balance = other.balanceOf(address(this));

        if (address(other) == address(token)) {
            uint256 committed = totalCommitted;
            if (balance <= committed) revert NothingToSweep();
            balance -= committed;
        }

        other.safeTransfer(to, balance);
    }
}
