// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {RemessoExecutorV5} from "../src/RemessoExecutorV5.sol";

/**
 * Celo mainnet:
 *   forge script script/DeployV5.s.sol:DeployV5 --rpc-url celo --broadcast --verify
 *
 * Deploys ALONGSIDE V4 (0x288b7cDD…6009). A migration, not an upgrade — see
 * DeployV4 for what that means for senders. V5 is V4 with the fixes from the
 * 2026-10-16 solidity-auditor scans; see the contract's header.
 *
 * The constructor only. The allowlists are set afterwards with separate
 * transactions carrying the ERC-8021 attribution suffix, which a creation
 * transaction cannot carry: trailing bytes on init code are read as
 * constructor arguments. The allowlists mirror V4's as read on-chain on
 * 2026-10-16:
 *
 *   Direct: USDT, USDC, USDm, USA₮, wARS, wBRL, wCOP, cNGN
 *   Swap payout: cNGN (constructor), USDC, USDm
 */
contract DeployV5 is Script {
    address constant USDT = 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e;
    address constant CNGN = 0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f;
    address constant SWAP_ROUTER_02 = 0x5615CDAb10dc425a742d643d949a7F474C01abc4;

    // The only USDT/cNGN pool on Celo — see DeployV4.
    uint24 constant POOL_FEE = 100;

    /// 0.25%, as on V4. MAX_FEE_BPS is 50 in code.
    uint16 constant FEE_BPS = 25;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address executor = vm.envAddress("EXECUTOR_ADDRESS");
        address treasury = vm.envOr("TREASURY_ADDRESS", vm.addr(pk));

        vm.startBroadcast(pk);
        RemessoExecutorV5 exec =
            new RemessoExecutorV5(USDT, CNGN, SWAP_ROUTER_02, executor, POOL_FEE, treasury, FEE_BPS);
        vm.stopBroadcast();

        console2.log("RemessoExecutorV5:", address(exec));
        console2.log("owner / deployer: ", vm.addr(pk));
        console2.log("executor:         ", executor);
        console2.log("treasury:         ", treasury);
        console2.log("feeBps:           ", FEE_BPS);
    }
}
