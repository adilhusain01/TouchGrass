// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AllowanceVault} from "../src/AllowanceVault.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

contract AllowanceVaultTest is Test {
    uint96 private constant DAILY_USDC = 1_000_000;
    uint256 private constant VERIFIER_KEY = 0xA11CE;
    address private verifier = vm.addr(VERIFIER_KEY);
    address private owner = makeAddr("owner");
    address private beneficiary = makeAddr("beneficiary");
    AllowanceVault private vault;
    MockUSDC private usdc;
    uint64 private startAt;

    function setUp() public {
        usdc = new MockUSDC();
        vault = new AllowanceVault(verifier, usdc);
        usdc.mint();
        vm.prank(address(this));
        usdc.transfer(owner, 100_000_000);
        vm.prank(owner);
        usdc.approve(address(vault), type(uint256).max);
        startAt = uint64(block.timestamp + 1 days);
    }

    function testCreatesFullyFundedProgram() public {
        vm.prank(owner);
        uint256 id = vault.createProgram(14, 3 hours, DAILY_USDC, beneficiary, startAt);
        (address programOwner,,,,,,) = vault.programs(id);
        assertEq(programOwner, owner);
        assertEq(usdc.balanceOf(address(vault)), 14_000_000);
    }

    function testRejectsProgramWithoutApproval() public {
        vm.prank(owner);
        usdc.approve(address(vault), 0);
        vm.expectRevert();
        vm.prank(owner);
        vault.createProgram(14, 3 hours, DAILY_USDC, beneficiary, startAt);
    }

    function testClaimsExactlyOnceAfterDayCompletes() public {
        uint256 id = _createProgram();
        vm.warp(uint256(startAt) + 2 days);
        uint64 validUntil = uint64(block.timestamp + 1 hours);
        bytes memory signature = _sign(id, 0, validUntil);

        vault.claim(id, 0, validUntil, signature);
        assertEq(usdc.balanceOf(beneficiary), DAILY_USDC);

        vm.expectRevert(AllowanceVault.AlreadyClaimed.selector);
        vault.claim(id, 0, validUntil, signature);
    }

    function testRejectsEarlyAndAlteredClaims() public {
        uint256 id = _createProgram();
        uint64 validUntil = uint64(uint256(startAt) + 2 days);
        bytes memory signature = _sign(id, 0, validUntil);

        vm.expectRevert(AllowanceVault.DayNotComplete.selector);
        vault.claim(id, 0, validUntil, signature);

        vm.warp(uint256(startAt) + 2 days);
        vm.expectRevert(AllowanceVault.InvalidVoucher.selector);
        vault.claim(id, 1, validUntil, signature);
    }

    function testSavingsOnlyUnlockAfterProgramAndCooldown() public {
        uint256 id = _createProgram();
        vm.prank(owner);
        vm.expectRevert(AllowanceVault.SavingsStillLocked.selector);
        vault.withdrawMaturedSavings(id);

        vm.warp(uint256(startAt) + 14 days + vault.COOLDOWN());
        uint256 before = usdc.balanceOf(owner);
        vm.prank(owner);
        vault.withdrawMaturedSavings(id);
        assertEq(usdc.balanceOf(owner), before + 14_000_000);
    }

    function _createProgram() private returns (uint256) {
        vm.prank(owner);
        return vault.createProgram(14, 3 hours, DAILY_USDC, beneficiary, startAt);
    }

    function _sign(uint256 id, uint16 dayIndex, uint64 validUntil) private view returns (bytes memory) {
        bytes32 digest = vault.claimDigest(id, beneficiary, dayIndex, validUntil);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(VERIFIER_KEY, digest);
        return abi.encodePacked(r, s, v);
    }
}
