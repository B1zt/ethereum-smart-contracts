// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Collection721} from "../src/Collection721.sol";
import {Editions1155} from "../src/Editions1155.sol";
import {EnglishAuction} from "../src/EnglishAuction.sol";
import {Marketplace} from "../src/Marketplace.sol";

/// @notice Deploys the full marketplace stack and prints the environment block the backend and
///         frontend need.
///
/// @dev Usage:
///
///        forge script script/Deploy.s.sol:Deploy \
///          --rpc-url $SEPOLIA_RPC_URL --broadcast --verify
///
///      The owner defaults to the deployer, which is fine for a testnet. On mainnet, pass a
///      multisig via the OWNER environment variable: every privileged function on these contracts
///      is `onlyOwner`, and a single EOA holding that is the most common way these systems get
///      drained.
contract Deploy is Script {
    uint96 internal constant PROTOCOL_FEE_BPS = 250; // 2.5%
    uint96 internal constant ROYALTY_BPS = 500; // 5%
    uint256 internal constant MAX_SUPPLY = 10_000;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        // Falls back to the deployer so the script runs unmodified against a local Anvil node.
        address owner = vm.envOr("OWNER", deployer);
        address treasury = vm.envOr("TREASURY", deployer);
        address royaltyReceiver = vm.envOr("ROYALTY_RECEIVER", deployer);
        address weth = vm.envOr("WETH", address(0));

        vm.startBroadcast(deployerKey);

        Marketplace marketplace = new Marketplace(owner, treasury, PROTOCOL_FEE_BPS);
        EnglishAuction auction = new EnglishAuction(owner, treasury, PROTOCOL_FEE_BPS);

        Collection721 collection = new Collection721(
            "B1zt Genesis",
            "BZTG",
            MAX_SUPPLY,
            "ipfs://placeholder-metadata.json",
            treasury,
            royaltyReceiver,
            ROYALTY_BPS,
            owner
        );

        Editions1155 editions =
            new Editions1155("B1zt Editions", "BZTE", treasury, royaltyReceiver, ROYALTY_BPS, owner);

        vm.stopBroadcast();

        // WETH has to be allowlisted before any offer can be made, and offers are the half of the
        // order book that cannot use native ETH. Skipped when no WETH address was supplied.
        if (weth != address(0) && owner == deployer) {
            vm.startBroadcast(deployerKey);
            marketplace.setCurrencyAllowed(weth, true);
            auction.setCurrencyAllowed(weth, true);
            vm.stopBroadcast();
        }

        _report(address(marketplace), address(auction), address(collection), address(editions), weth, owner);
    }

    function _report(
        address marketplace,
        address auction,
        address collection,
        address editions,
        address weth,
        address owner
    ) internal view {
        console.log("");
        console.log("=== Deployed ===");
        console.log("chainId          ", block.chainid);
        console.log("owner            ", owner);
        console.log("Marketplace      ", marketplace);
        console.log("EnglishAuction   ", auction);
        console.log("Collection721    ", collection);
        console.log("Editions1155     ", editions);
        console.log("WETH             ", weth);
        console.log("deployBlock      ", block.number);

        console.log("");
        console.log("--- backend/.env ---");
        console.log("CHAIN_ID=%s", vm.toString(block.chainid));
        console.log("MARKETPLACE_ADDRESS=%s", vm.toString(marketplace));
        console.log("AUCTION_ADDRESS=%s", vm.toString(auction));
        console.log("COLLECTION_ADDRESS=%s", vm.toString(collection));
        console.log("DEPLOY_BLOCK=%s", vm.toString(block.number));

        console.log("");
        console.log("--- frontend/.env.local ---");
        console.log("NEXT_PUBLIC_CHAIN_ID=%s", vm.toString(block.chainid));
        console.log("NEXT_PUBLIC_MARKETPLACE_ADDRESS=%s", vm.toString(marketplace));
        console.log("NEXT_PUBLIC_AUCTION_ADDRESS=%s", vm.toString(auction));
        console.log("NEXT_PUBLIC_COLLECTION_ADDRESS=%s", vm.toString(collection));
        console.log("NEXT_PUBLIC_WETH_ADDRESS=%s", vm.toString(weth));

        if (owner != marketplace && owner != auction) {
            console.log("");
            console.log("Next: as the owner, call setCurrencyAllowed(WETH, true) on both venues");
            console.log("      and addPhase(...) on the collection to open minting.");
        }
    }
}
