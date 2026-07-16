// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AllowanceVault} from "../src/AllowanceVault.sol";

contract AllowanceVaultTest is Test {
    uint256 private constant VERIFIER_KEY = 0xA11CE;
    address private verifier = vm.addr(VERIFIER_KEY);
    address private owner = makeAddr("owner");
    address private beneficiary = makeAddr("beneficiary");
    AllowanceVault private vault;
    uint64 private startAt;

    function setUp() public {
        vault = new AllowanceVault(verifier);
        vm.deal(owner, 100 ether);
        startAt = uint64(block.timestamp + 1 days);
    }

    function testCreatesFullyFundedProgram() public {
        vm.prank(owner);
        uint256 id = vault.createProgram{value: 14 ether}(14, 3 hours, 1 ether, beneficiary, startAt);
        (address programOwner,,,,,,) = vault.programs(id);
        assertEq(programOwner, owner);
        assertEq(address(vault).balance, 14 ether);
    }

    function testRejectsUnderfundedProgram() public {
        vm.expectRevert(AllowanceVault.BadFunding.selector);
        vm.prank(owner);
        vault.createProgram{value: 13 ether}(14, 3 hours, 1 ether, beneficiary, startAt);
    }

    function testClaimsExactlyOnceAfterDayCompletes() public {
        uint256 id = _createProgram();
        vm.warp(uint256(startAt) + 2 days);
        uint64 validUntil = uint64(block.timestamp + 1 hours);
        bytes memory signature = _sign(id, 0, validUntil);

        vault.claim(id, 0, validUntil, signature);
        assertEq(beneficiary.balance, 1 ether);

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
        uint256 before = owner.balance;
        vm.prank(owner);
        vault.withdrawMaturedSavings(id);
        assertEq(owner.balance, before + 14 ether);
    }

    function _createProgram() private returns (uint256) {
        vm.prank(owner);
        return vault.createProgram{value: 14 ether}(14, 3 hours, 1 ether, beneficiary, startAt);
    }

    function _sign(uint256 id, uint16 dayIndex, uint64 validUntil) private view returns (bytes memory) {
        bytes32 digest = vault.claimDigest(id, beneficiary, dayIndex, validUntil);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(VERIFIER_KEY, digest);
        return abi.encodePacked(r, s, v);
    }
}
