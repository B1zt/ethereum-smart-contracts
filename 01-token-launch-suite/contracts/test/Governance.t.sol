// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ProjectGovernor} from "../src/ProjectGovernor.sol";
import {ProjectToken} from "../src/ProjectToken.sol";

contract GovernanceTest is Test {
    ProjectToken internal token;
    TimelockController internal timelock;
    ProjectGovernor internal governor;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint256 internal constant CAP = 1_000_000_000e18;
    uint256 internal constant INITIAL = 100_000_000e18;

    uint48 internal constant VOTING_DELAY = 1 days;
    uint32 internal constant VOTING_PERIOD = 7 days;
    uint256 internal constant PROPOSAL_THRESHOLD = 100_000e18;
    uint256 internal constant QUORUM_PERCENT = 4;
    uint256 internal constant TIMELOCK_DELAY = 2 days;

    function setUp() public {
        vm.warp(1_800_000_000);

        token = new ProjectToken("Project", "PRJ", CAP, INITIAL, treasury, admin);

        address[] memory empty = new address[](0);
        timelock = new TimelockController(TIMELOCK_DELAY, empty, empty, admin);

        governor = new ProjectGovernor(
            IVotes(address(token)), timelock, VOTING_DELAY, VOTING_PERIOD, PROPOSAL_THRESHOLD, QUORUM_PERCENT
        );

        // Governor proposes, anyone executes, and the deployer's admin role is renounced so the
        // timelock is genuinely controlled by governance rather than by a person.
        vm.startPrank(admin);
        timelock.grantRole(timelock.PROPOSER_ROLE(), address(governor));
        timelock.grantRole(timelock.CANCELLER_ROLE(), address(governor));
        timelock.grantRole(timelock.EXECUTOR_ROLE(), address(0));
        timelock.revokeRole(timelock.DEFAULT_ADMIN_ROLE(), admin);
        vm.stopPrank();

        // Hand the token's admin role to the timelock, so minting is governed.
        vm.startPrank(admin);
        token.grantRole(token.DEFAULT_ADMIN_ROLE(), address(timelock));
        token.grantRole(token.MINTER_ROLE(), address(timelock));
        vm.stopPrank();

        // Distribute and delegate. Voting power only exists once delegated, which is the single
        // most common source of confusion with ERC20Votes.
        vm.startPrank(treasury);
        token.transfer(alice, 40_000_000e18);
        token.transfer(bob, 30_000_000e18);
        token.transfer(carol, 1_000e18);
        vm.stopPrank();

        vm.prank(alice);
        token.delegate(alice);
        vm.prank(bob);
        token.delegate(bob);
        vm.prank(carol);
        token.delegate(carol);

        // Checkpoints are taken at a past timepoint, so move forward before proposing.
        vm.warp(block.timestamp + 1);
    }

    function _mintProposal()
        internal
        view
        returns (
            address[] memory targets,
            uint256[] memory values,
            bytes[] memory calldatas,
            string memory description
        )
    {
        targets = new address[](1);
        values = new uint256[](1);
        calldatas = new bytes[](1);

        targets[0] = address(token);
        values[0] = 0;
        calldatas[0] = abi.encodeWithSelector(ProjectToken.mint.selector, treasury, 1_000_000e18);
        description = "Mint 1M to treasury";
    }

    /*//////////////////////////////////////////////////////////////
                              VOTING POWER
    //////////////////////////////////////////////////////////////*/

    /// @dev Tokens confer no voting power until delegated, including to yourself.
    function test_votingPowerRequiresDelegation() public {
        address dave = makeAddr("dave");

        vm.prank(treasury);
        token.transfer(dave, 1_000_000e18);

        vm.warp(block.timestamp + 1);
        assertEq(token.getVotes(dave), 0, "holding is not voting");

        vm.prank(dave);
        token.delegate(dave);

        vm.warp(block.timestamp + 1);
        assertEq(token.getVotes(dave), 1_000_000e18);
    }

    function test_clockIsTimestampBased() public view {
        assertEq(token.clock(), uint48(block.timestamp));
        assertEq(token.CLOCK_MODE(), "mode=timestamp");
    }

    /*//////////////////////////////////////////////////////////////
                             PROPOSAL FLOW
    //////////////////////////////////////////////////////////////*/

    function test_fullProposalLifecycle() public {
        (
            address[] memory targets,
            uint256[] memory values,
            bytes[] memory calldatas,
            string memory description
        ) = _mintProposal();

        vm.prank(alice);
        uint256 proposalId = governor.propose(targets, values, calldatas, description);

        assertEq(uint256(governor.state(proposalId)), uint256(IGovernor.ProposalState.Pending));

        vm.warp(block.timestamp + VOTING_DELAY + 1);
        assertEq(uint256(governor.state(proposalId)), uint256(IGovernor.ProposalState.Active));

        vm.prank(alice);
        governor.castVote(proposalId, 1); // For
        vm.prank(bob);
        governor.castVote(proposalId, 1);

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        assertEq(uint256(governor.state(proposalId)), uint256(IGovernor.ProposalState.Succeeded));

        bytes32 descriptionHash = keccak256(bytes(description));
        governor.queue(targets, values, calldatas, descriptionHash);
        assertEq(uint256(governor.state(proposalId)), uint256(IGovernor.ProposalState.Queued));

        uint256 supplyBefore = token.totalSupply();

        vm.warp(block.timestamp + TIMELOCK_DELAY + 1);
        governor.execute(targets, values, calldatas, descriptionHash);

        assertEq(uint256(governor.state(proposalId)), uint256(IGovernor.ProposalState.Executed));
        assertEq(token.totalSupply() - supplyBefore, 1_000_000e18, "proposal actually minted");
    }

    /// @dev The timelock delay is the whole protection for holders who disagree with a decision.
    ///      Executing before it elapses must fail.
    function test_cannotExecuteBeforeTimelockDelay() public {
        (
            address[] memory targets,
            uint256[] memory values,
            bytes[] memory calldatas,
            string memory description
        ) = _mintProposal();

        vm.prank(alice);
        uint256 proposalId = governor.propose(targets, values, calldatas, description);

        vm.warp(block.timestamp + VOTING_DELAY + 1);
        vm.prank(alice);
        governor.castVote(proposalId, 1);

        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        bytes32 descriptionHash = keccak256(bytes(description));
        governor.queue(targets, values, calldatas, descriptionHash);

        // One second short of the delay.
        vm.warp(block.timestamp + TIMELOCK_DELAY - 1);
        vm.expectRevert();
        governor.execute(targets, values, calldatas, descriptionHash);
    }

    /// @dev Below the threshold, anyone could spam the queue.
    function test_proposalRequiresThreshold() public {
        (
            address[] memory targets,
            uint256[] memory values,
            bytes[] memory calldatas,
            string memory description
        ) = _mintProposal();

        // Carol holds 1,000 against a 100,000 threshold.
        vm.prank(carol);
        vm.expectRevert();
        governor.propose(targets, values, calldatas, description);
    }

    function test_proposalFailsWithoutQuorum() public {
        (
            address[] memory targets,
            uint256[] memory values,
            bytes[] memory calldatas,
            string memory description
        ) = _mintProposal();

        vm.prank(alice);
        uint256 proposalId = governor.propose(targets, values, calldatas, description);

        vm.warp(block.timestamp + VOTING_DELAY + 1);

        // Carol votes for, but 1,000 tokens is far below 4% of a 100M supply.
        vm.prank(carol);
        governor.castVote(proposalId, 1);

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        assertEq(uint256(governor.state(proposalId)), uint256(IGovernor.ProposalState.Defeated));
    }

    function test_againstVotesAreCountedInTheTally() public {
        (
            address[] memory targets,
            uint256[] memory values,
            bytes[] memory calldatas,
            string memory description
        ) = _mintProposal();

        vm.prank(alice);
        uint256 proposalId = governor.propose(targets, values, calldatas, description);

        vm.warp(block.timestamp + VOTING_DELAY + 1);

        vm.prank(bob);
        governor.castVote(proposalId, 0); // Against, 30M
        vm.prank(alice);
        governor.castVote(proposalId, 1); // For, 40M

        // Quorum is met, but let a larger Against block win instead.
        vm.prank(treasury);
        token.delegate(treasury);
        vm.warp(block.timestamp + 1);

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        // For 40M vs Against 30M, so it succeeds. The point of this test is that Against votes are
        // counted at all and that the tally is what decides the outcome.
        assertEq(uint256(governor.state(proposalId)), uint256(IGovernor.ProposalState.Succeeded));

        (uint256 against, uint256 forVotes,) = governor.proposalVotes(proposalId);
        assertEq(against, 30_000_000e18);
        assertEq(forVotes, 40_000_000e18);
    }

    /// @dev Voting power is snapshotted when the vote opens, so buying tokens mid-vote confers
    ///      nothing. This is what makes flash-loan governance attacks unprofitable.
    function test_votingPowerIsSnapshotted() public {
        (
            address[] memory targets,
            uint256[] memory values,
            bytes[] memory calldatas,
            string memory description
        ) = _mintProposal();

        vm.prank(alice);
        uint256 proposalId = governor.propose(targets, values, calldatas, description);

        vm.warp(block.timestamp + VOTING_DELAY + 1);

        // Carol acquires a huge position after the snapshot.
        vm.prank(treasury);
        token.transfer(carol, 20_000_000e18);
        vm.warp(block.timestamp + 1);

        vm.prank(carol);
        governor.castVote(proposalId, 1);

        (, uint256 forVotes,) = governor.proposalVotes(proposalId);
        assertEq(forVotes, 1_000e18, "only the snapshotted balance counted");
    }

    /*//////////////////////////////////////////////////////////////
                             ACCESS CONTROL
    //////////////////////////////////////////////////////////////*/

    /// @dev The timelock must be the only path to a privileged action. A direct call bypassing
    ///      governance defeats the entire structure.
    function test_privilegedCallsRequireGovernance() public {
        vm.prank(alice);
        vm.expectRevert();
        token.mint(alice, 1_000e18);
    }

    function test_timelockCanMint() public {
        uint256 before = token.balanceOf(treasury);

        vm.prank(address(timelock));
        token.mint(treasury, 1_000e18);

        assertEq(token.balanceOf(treasury) - before, 1_000e18);
    }

    /// @dev With the deployer's admin role renounced, nobody can grant themselves proposer rights.
    ///      This is what makes the timelock genuinely governed rather than merely appearing to be.
    function test_deployerCannotReclaimTimelock() public {
        // Read the role id first. `vm.prank` applies to the very next external call, and a nested
        // `timelock.PROPOSER_ROLE()` inside the argument list would consume it, leaving `grantRole`
        // to run as the test contract and quietly invalidating the test.
        bytes32 proposerRole = timelock.PROPOSER_ROLE();

        assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), admin), "admin role renounced");

        vm.prank(admin);
        vm.expectRevert();
        timelock.grantRole(proposerRole, admin);
    }
}
