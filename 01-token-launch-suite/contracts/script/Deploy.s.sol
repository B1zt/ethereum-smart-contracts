// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MerkleDistributor} from "../src/MerkleDistributor.sol";
import {ProjectGovernor} from "../src/ProjectGovernor.sol";
import {ProjectToken} from "../src/ProjectToken.sol";
import {StakingVault} from "../src/StakingVault.sol";
import {TokenVesting} from "../src/TokenVesting.sol";

/// @notice Deploys the token, distribution and governance stack, then hands control to the timelock.
///
/// @dev The ordering matters and is the part most deployments get wrong. Contracts are deployed
///      with the deployer as admin so it can wire everything up, and the very last step transfers
///      every privileged role to the timelock and renounces the deployer's own. A deployment that
///      skips that final step leaves an EOA able to mint, revoke vesting and drain the staking
///      vault, no matter how well governed the system looks on paper.
contract Deploy is Script {
    uint256 internal constant CAP = 1_000_000_000e18;
    uint256 internal constant INITIAL_SUPPLY = 100_000_000e18;

    uint48 internal constant VOTING_DELAY = 1 days;
    uint32 internal constant VOTING_PERIOD = 7 days;
    uint256 internal constant PROPOSAL_THRESHOLD = 1_000_000e18; // 1% of initial supply
    uint256 internal constant QUORUM_PERCENT = 4;
    uint256 internal constant TIMELOCK_DELAY = 2 days;

    uint64 internal constant REWARD_DURATION = 30 days;

    /// @dev Deployed addresses bundled into one slot-efficient value. Holding six separate locals
    ///      plus the deployer overflows the EVM's 16-slot stack window in `run`.
    struct Deployment {
        ProjectToken token;
        TimelockController timelock;
        ProjectGovernor governor;
        TokenVesting vesting;
        MerkleDistributor distributor;
        StakingVault vault;
        address deployer;
    }

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        Deployment memory d;
        d.deployer = vm.addr(deployerKey);

        address treasury = vm.envOr("TREASURY", d.deployer);
        bytes32 airdropRoot = vm.envOr("AIRDROP_MERKLE_ROOT", bytes32(0));
        uint256 airdropDeadline = vm.envOr("AIRDROP_DEADLINE", block.timestamp + 90 days);

        vm.startBroadcast(deployerKey);

        // 1. Token. The deployer holds admin for now so it can wire the rest up.
        d.token = new ProjectToken("Project Token", "PRJ", CAP, INITIAL_SUPPLY, treasury, d.deployer);

        // 2. Timelock. Roles are granted once the governor exists.
        address[] memory empty = new address[](0);
        d.timelock = new TimelockController(TIMELOCK_DELAY, empty, empty, d.deployer);

        // 3. Governor.
        d.governor = new ProjectGovernor(
            IVotes(address(d.token)), d.timelock, VOTING_DELAY, VOTING_PERIOD, PROPOSAL_THRESHOLD, QUORUM_PERCENT
        );

        // 4. Distribution and staking, owned by the timelock from the start.
        d.vesting = new TokenVesting(IERC20(address(d.token)), address(d.timelock));

        d.distributor =
            new MerkleDistributor(IERC20(address(d.token)), airdropRoot, airdropDeadline, address(d.timelock));

        d.vault = new StakingVault(
            IERC20(address(d.token)), "Staked PRJ", "sPRJ", REWARD_DURATION, address(d.timelock)
        );

        // 5. Wire the timelock: the governor proposes, anyone executes.
        d.timelock.grantRole(d.timelock.PROPOSER_ROLE(), address(d.governor));
        d.timelock.grantRole(d.timelock.CANCELLER_ROLE(), address(d.governor));
        // An open executor role is safe: execution can only run what the timelock already queued,
        // and it means a passed proposal cannot stall waiting for one specific keeper.
        d.timelock.grantRole(d.timelock.EXECUTOR_ROLE(), address(0));

        // 6. Hand the token over to governance.
        d.token.grantRole(d.token.DEFAULT_ADMIN_ROLE(), address(d.timelock));
        d.token.grantRole(d.token.MINTER_ROLE(), address(d.timelock));

        // 7. Renounce everything the deployer holds. After this it is an ordinary address.
        d.token.renounceRole(d.token.MINTER_ROLE(), d.deployer);
        d.token.renounceRole(d.token.DEFAULT_ADMIN_ROLE(), d.deployer);
        d.timelock.renounceRole(d.timelock.DEFAULT_ADMIN_ROLE(), d.deployer);

        vm.stopBroadcast();

        _report(d);
    }

    function _report(Deployment memory d) internal view {
        console.log("");
        console.log("=== Deployed ===");
        console.log("chainId           ", block.chainid);
        console.log("ProjectToken      ", address(d.token));
        console.log("TimelockController", address(d.timelock));
        console.log("ProjectGovernor   ", address(d.governor));
        console.log("TokenVesting      ", address(d.vesting));
        console.log("MerkleDistributor ", address(d.distributor));
        console.log("StakingVault      ", address(d.vault));
        console.log("deployBlock       ", block.number);

        console.log("");
        console.log("--- backend/.env ---");
        console.log("CHAIN_ID=%s", vm.toString(block.chainid));
        console.log("TOKEN_ADDRESS=%s", vm.toString(address(d.token)));
        console.log("TIMELOCK_ADDRESS=%s", vm.toString(address(d.timelock)));
        console.log("GOVERNOR_ADDRESS=%s", vm.toString(address(d.governor)));
        console.log("VESTING_ADDRESS=%s", vm.toString(address(d.vesting)));
        console.log("DISTRIBUTOR_ADDRESS=%s", vm.toString(address(d.distributor)));
        console.log("VAULT_ADDRESS=%s", vm.toString(address(d.vault)));
        console.log("DEPLOY_BLOCK=%s", vm.toString(block.number));

        console.log("");
        console.log("--- ownership check ---");
        console.log("deployer still minter?   ", d.token.hasRole(d.token.MINTER_ROLE(), d.deployer));
        console.log("deployer still admin?    ", d.token.hasRole(d.token.DEFAULT_ADMIN_ROLE(), d.deployer));
        console.log("timelock is token admin? ", d.token.hasRole(d.token.DEFAULT_ADMIN_ROLE(), address(d.timelock)));
        console.log("vesting owner is timelock?", d.vesting.owner() == address(d.timelock));
        console.log("vault owner is timelock?  ", d.vault.owner() == address(d.timelock));
        console.log("");
        console.log("All three deployer lines above must read false, false, true.");
    }
}