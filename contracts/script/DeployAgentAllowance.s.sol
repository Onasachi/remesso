// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {RemessoAgentAllowance} from "../src/RemessoAgentAllowance.sol";

/**
 * Celo mainnet:
 *   forge script script/DeployAgentAllowance.s.sol:DeployAgentAllowance --rpc-url celo --broadcast --verify
 *
 * The contract has no owner and no constructor arguments: the deployer gets no
 * power over it. DEPLOYER_PRIVATE_KEY only pays the gas.
 */
contract DeployAgentAllowance is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(pk);
        RemessoAgentAllowance aa = new RemessoAgentAllowance();
        vm.stopBroadcast();
        console2.log("RemessoAgentAllowance:", address(aa));
    }
}
