// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {AllowanceVault} from "../src/AllowanceVault.sol";

contract DeployAllowanceVault is Script {
    function run() external returns (AllowanceVault vault) {
        address verifier = vm.envAddress("VERIFIER_ADDRESS");
        vm.startBroadcast();
        vault = new AllowanceVault(verifier);
        vm.stopBroadcast();
    }
}
