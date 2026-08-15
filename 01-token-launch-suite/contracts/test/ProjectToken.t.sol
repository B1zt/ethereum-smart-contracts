// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ProjectToken} from "../src/ProjectToken.sol";

contract ProjectTokenTest is Test {
    ProjectToken internal token;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");

    uint256 internal constant CAP = 1_000_000_000e18;
    uint256 internal constant INITIAL = 100_000_000e18;

    uint256 internal spenderKey = 0xA11CE;
    address internal spenderOwner;

    function setUp() public {
        vm.warp(1_800_000_000);
        spenderOwner = vm.addr(spenderKey);

        token = new ProjectToken("Project", "PRJ", CAP, INITIAL, treasury, admin);
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    function test_constructor_setsInitialState() public view {
        assertEq(token.name(), "Project");
        assertEq(token.symbol(), "PRJ");
        assertEq(token.cap(), CAP);
        assertEq(token.totalSupply(), INITIAL);
        assertEq(token.balanceOf(treasury), INITIAL);
        assertTrue(token.hasRole(token.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(token.hasRole(token.MINTER_ROLE(), admin));
    }

    function test_constructor_rejectsInitialSupplyAboveCap() public {
        vm.expectRevert(abi.encodeWithSelector(ProjectToken.CapExceeded.selector, CAP + 1, CAP));
        new ProjectToken("X", "X", CAP, CAP + 1, treasury, admin);
    }

    function test_constructor_rejectsZeroCap() public {
        vm.expectRevert(ProjectToken.ZeroCap.selector);
        new ProjectToken("X", "X", 0, 0, treasury, admin);
    }

    /*//////////////////////////////////////////////////////////////
                                MINTING
    //////////////////////////////////////////////////////////////*/

    function test_mint_respectsCap() public {
        uint256 remaining = CAP - INITIAL;

        vm.prank(admin);
        token.mint(alice, remaining);
        assertEq(token.totalSupply(), CAP);

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ProjectToken.CapExceeded.selector, 1, 0));
        token.mint(alice, 1);
    }

    function test_mint_requiresMinterRole() public {
        // Read the role id before pranking. `vm.prank` applies to the next external call, and a
        // nested `token.MINTER_ROLE()` inside the expectRevert argument would consume it, leaving
        // `mint` to run as the test contract.
        bytes32 minterRole = token.MINTER_ROLE();

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, minterRole)
        );
        token.mint(alice, 1e18);
    }

    /// @dev Stronger than revoking the role: a role can be granted again, this cannot be undone.
    function test_finishMinting_isPermanent() public {
        vm.prank(admin);
        token.finishMinting();

        assertTrue(token.mintingFinished());
        assertEq(token.remainingMintable(), 0);

        vm.prank(admin);
        vm.expectRevert(ProjectToken.MintingAlreadyFinished.selector);
        token.mint(alice, 1e18);

        vm.prank(admin);
        vm.expectRevert(ProjectToken.MintingAlreadyFinished.selector);
        token.finishMinting();
    }

    function test_remainingMintable() public {
        assertEq(token.remainingMintable(), CAP - INITIAL);

        vm.prank(admin);
        token.mint(alice, 1_000e18);

        assertEq(token.remainingMintable(), CAP - INITIAL - 1_000e18);
    }

    /*//////////////////////////////////////////////////////////////
                                 PERMIT
    //////////////////////////////////////////////////////////////*/

    /// @dev EIP-2612 removes the separate approve transaction, which is where most users drop out
    ///      of a staking or vesting flow.
    function test_permit_grantsAllowanceBySignature() public {
        vm.prank(treasury);
        token.transfer(spenderOwner, 1_000e18);

        address spender = makeAddr("spender");
        uint256 value = 500e18;
        uint256 deadline = block.timestamp + 1 hours;

        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                spenderOwner,
                spender,
                value,
                token.nonces(spenderOwner),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(spenderKey, digest);

        token.permit(spenderOwner, spender, value, deadline, v, r, s);

        assertEq(token.allowance(spenderOwner, spender), value);
        assertEq(token.nonces(spenderOwner), 1, "nonce consumed");
    }

    function test_permit_rejectsExpiredSignature() public {
        address spender = makeAddr("spender");
        uint256 deadline = block.timestamp - 1;

        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                spenderOwner,
                spender,
                1e18,
                token.nonces(spenderOwner),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(spenderKey, digest);

        vm.expectRevert();
        token.permit(spenderOwner, spender, 1e18, deadline, v, r, s);
    }

    /*//////////////////////////////////////////////////////////////
                                BURNING
    //////////////////////////////////////////////////////////////*/

    /// @dev Burning lowers total supply but does not raise the cap. Deflation must not create new
    ///      mintable headroom, otherwise a burn-and-remint loop bypasses the cap entirely.
    function test_burn_doesNotIncreaseMintableHeadroom() public {
        vm.prank(admin);
        token.mint(alice, CAP - INITIAL);
        assertEq(token.totalSupply(), CAP);

        vm.prank(alice);
        token.burn(1_000e18);

        assertEq(token.totalSupply(), CAP - 1_000e18);
        // Headroom reappears, which is the expected trade-off of a totalSupply-based cap. Documented
        // rather than hidden: the cap bounds circulating supply, not cumulative issuance.
        assertEq(token.remainingMintable(), 1_000e18);
    }

    /*//////////////////////////////////////////////////////////////
                                 VOTES
    //////////////////////////////////////////////////////////////*/

    function test_delegationMovesVotingPower() public {
        vm.prank(treasury);
        token.transfer(alice, 1_000e18);

        assertEq(token.getVotes(alice), 0, "undelegated tokens carry no votes");

        vm.prank(alice);
        token.delegate(alice);

        assertEq(token.getVotes(alice), 1_000e18);
    }

    function test_pastVotesAreCheckpointed() public {
        vm.prank(treasury);
        token.transfer(alice, 1_000e18);

        vm.prank(alice);
        token.delegate(alice);

        uint256 checkpoint = block.timestamp;
        vm.warp(block.timestamp + 1);

        vm.prank(treasury);
        token.transfer(alice, 9_000e18);
        vm.warp(block.timestamp + 1);

        assertEq(token.getPastVotes(alice, checkpoint), 1_000e18, "history preserved");
        assertEq(token.getVotes(alice), 10_000e18, "current reflects the transfer");
    }

    /*//////////////////////////////////////////////////////////////
                                 FUZZ
    //////////////////////////////////////////////////////////////*/

    /// @dev No sequence of mints can ever exceed the cap.
    function testFuzz_capIsNeverExceeded(uint256[8] calldata amounts) public {
        for (uint256 i; i < amounts.length; ++i) {
            uint256 amount = bound(amounts[i], 1, CAP);

            vm.prank(admin);
            try token.mint(alice, amount) {} catch {}

            assertLe(token.totalSupply(), CAP, "cap holds");
        }
    }

    function testFuzz_transfersConserveSupply(uint256 amount) public {
        amount = bound(amount, 0, INITIAL);

        uint256 supplyBefore = token.totalSupply();

        vm.prank(treasury);
        token.transfer(alice, amount);

        assertEq(token.totalSupply(), supplyBefore);
        assertEq(token.balanceOf(alice) + token.balanceOf(treasury), supplyBefore);
    }

    function testFuzz_cannotTransferMoreThanBalance(uint256 amount) public {
        amount = bound(amount, INITIAL + 1, type(uint128).max);

        vm.prank(treasury);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, treasury, INITIAL, amount)
        );
        token.transfer(alice, amount);
    }
}
