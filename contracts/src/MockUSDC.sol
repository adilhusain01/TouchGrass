// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

/// @notice Permissionless test token faucet. Never deploy this token for real value.
contract MockUSDC is ERC20 {
    uint256 public constant FAUCET_AMOUNT = 1_000_000_000; // 1,000 mUSDC (6 decimals)

    constructor() ERC20("Mock USD Coin", "mUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint() external {
        _mint(msg.sender, FAUCET_AMOUNT);
    }
}
