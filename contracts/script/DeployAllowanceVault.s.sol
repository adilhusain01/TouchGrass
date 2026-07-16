// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {AllowanceVault} from "../src/AllowanceVault.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

contract DeployAllowanceVault is Script {
    function run() external returns (MockUSDC mockUsdc, AllowanceVault vault) {
        address verifier = vm.envAddress("VERIFIER_ADDRESS");
        vm.startBroadcast();
        mockUsdc = new MockUSDC();
        vault = new AllowanceVault(verifier, mockUsdc);
        vm.stopBroadcast();
    }
}
