// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {Collection721} from "../src/Collection721.sol";
import {EnglishAuction} from "../src/EnglishAuction.sol";
import {TokenType} from "../src/OrderTypes.sol";

/// @title Demo
/// @notice Puts realistic state on a local chain so the UI can be clicked through.
///
/// @dev Run this after `Deploy.s.sol` against Anvil. It exists so a reviewer can see the whole
///      stack working without minting anything by hand, and so the screenshots in the README show
///      the app doing something rather than rendering empty states.
///
///      Only ever point this at a local chain. It mints supply to accounts whose private keys are
///      the public Anvil test mnemonic, which means anyone can spend them.
contract Demo is Script {
    /// Anvil's default accounts. Public keys, public mnemonic, worthless anywhere real.
    address constant ALICE = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address constant BOB = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;
    address constant CAROL = 0x90F79bf6EB2c4f870365E785982E1f101E93b906;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        // Inside a broadcast, msg.sender is the script's default sender rather than this key,
        // so the address has to be derived explicitly or the supply lands in the wrong wallet.
        address deployer = vm.addr(deployerKey);
        Collection721 collection = Collection721(payable(vm.envAddress("COLLECTION_ADDRESS")));
        EnglishAuction auction = EnglishAuction(payable(vm.envAddress("AUCTION_ADDRESS")));

        vm.startBroadcast(deployerKey);

        // An allowlist phase that has closed, and a public phase that is live. Two phases in
        // different states is what makes the mint page's timeline worth looking at.
        collection.addPhase(
            Collection721.Phase({
                merkleRoot: bytes32(uint256(1)),
                price: 0.05 ether,
                startTime: uint64(block.timestamp - 4 days),
                endTime: uint64(block.timestamp - 1 days),
                maxPerWallet: 0,
                maxSupply: 2_000
            })
        );

        collection.addPhase(
            Collection721.Phase({
                merkleRoot: bytes32(0),
                price: 0.08 ether,
                startTime: uint64(block.timestamp - 1 days),
                endTime: uint64(block.timestamp + 6 days),
                maxPerWallet: 5,
                maxSupply: 0
            })
        );

        // Supply spread across a few holders, so owner counts and portfolios are not all one wallet.
        collection.ownerMint(ALICE, 40);
        collection.ownerMint(BOB, 25);
        collection.ownerMint(CAROL, 18);
        collection.ownerMint(deployer, 12);

        // Reveal, so the collection page shows metadata rather than placeholders.
        collection.reveal("ipfs://bafybeigdyrztdemo0collection0metadata0root/");

        // One live auction, on a token the deployer holds. ERC721A numbers from zero, so the
        // deployer's block is the last 12 of the 95 minted above.
        uint256 tokenId = 84;
        collection.approve(address(auction), tokenId);

        uint256 auctionId = auction.createAuction(
            address(collection),
            tokenId,
            1,
            TokenType.ERC721,
            address(0),
            0.5 ether,
            uint64(block.timestamp),
            uint64(block.timestamp + 2 days),
            600,
            600,
            500
        );

        vm.stopBroadcast();

        console2.log("== demo state ==");
        console2.log("totalMinted ", collection.totalMinted());
        console2.log("phaseCount  ", collection.phaseCount());
        console2.log("auctionId   ", auctionId);
    }
}
