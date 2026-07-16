// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "openzeppelin-contracts/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Holds a voluntary screen-time budget and releases one daily allowance
/// only when TouchGrass's verifier signs a completed-day voucher.
contract AllowanceVault is EIP712 {
    using ECDSA for bytes32;
    using SafeERC20 for IERC20;

    uint256 public constant COOLDOWN = 7 days;
    uint16 public constant MIN_DURATION = 7;
    uint16 public constant MAX_DURATION = 28;

    bytes32 private constant CLAIM_VOUCHER_TYPEHASH =
        keccak256("ClaimVoucher(uint256 programId,address beneficiary,uint16 dayIndex,uint64 validUntil)");

    struct Program {
        address owner;
        address beneficiary;
        uint64 startAt;
        uint16 durationDays;
        uint32 dailyLimitSeconds;
        uint96 dailyAmount;
        uint256 claimedBitmap;
    }

    error BadDuration();
    error BadBeneficiary();
    error BadStartTime();
    error BadFunding();
    error NotProgramOwner();
    error DayOutOfRange();
    error DayNotComplete();
    error AlreadyClaimed();
    error VoucherExpired();
    error InvalidVoucher();
    error SavingsStillLocked();

    event ProgramCreated(
        uint256 indexed programId,
        address indexed owner,
        address indexed beneficiary,
        uint64 startAt,
        uint16 durationDays,
        uint32 dailyLimitSeconds,
        uint96 dailyAmount
    );
    event DailyAllowanceClaimed(uint256 indexed programId, uint16 indexed dayIndex, uint256 amount);
    event SavingsWithdrawn(uint256 indexed programId, address indexed owner, uint256 amount);

    address public immutable verifier;
    IERC20 public immutable asset;
    uint256 public nextProgramId;
    mapping(uint256 => Program) public programs;

    constructor(address verifier_, IERC20 asset_) EIP712("TouchGrassAllowanceVault", "1") {
        if (verifier_ == address(0) || address(asset_) == address(0)) revert BadBeneficiary();
        verifier = verifier_;
        asset = asset_;
    }

    function createProgram(
        uint16 durationDays,
        uint32 dailyLimitSeconds,
        uint96 dailyAmount,
        address beneficiary,
        uint64 startAt
    ) external returns (uint256 programId) {
        if (durationDays < MIN_DURATION || durationDays > MAX_DURATION) revert BadDuration();
        if (beneficiary == address(0)) revert BadBeneficiary();
        if (startAt < block.timestamp || startAt > block.timestamp + 30 days) revert BadStartTime();
        if (dailyAmount == 0) revert BadFunding();

        uint256 budget = uint256(durationDays) * dailyAmount;
        uint256 beforeBalance = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), budget);
        if (asset.balanceOf(address(this)) != beforeBalance + budget) revert BadFunding();

        programId = nextProgramId++;
        programs[programId] = Program({
            owner: msg.sender,
            beneficiary: beneficiary,
            startAt: startAt,
            durationDays: durationDays,
            dailyLimitSeconds: dailyLimitSeconds,
            dailyAmount: dailyAmount,
            claimedBitmap: 0
        });

        emit ProgramCreated(programId, msg.sender, beneficiary, startAt, durationDays, dailyLimitSeconds, dailyAmount);
    }

    function claim(uint256 programId, uint16 dayIndex, uint64 validUntil, bytes calldata signature) external {
        Program storage program = programs[programId];
        if (program.owner == address(0)) revert NotProgramOwner();
        if (dayIndex >= program.durationDays) revert DayOutOfRange();
        if (block.timestamp < uint256(program.startAt) + (uint256(dayIndex) + 1) * 1 days) {
            revert DayNotComplete();
        }
        if (block.timestamp > validUntil) revert VoucherExpired();

        uint256 mask = 1 << dayIndex;
        if (program.claimedBitmap & mask != 0) revert AlreadyClaimed();
        if (_recoverVoucher(programId, program.beneficiary, dayIndex, validUntil, signature) != verifier) {
            revert InvalidVoucher();
        }

        program.claimedBitmap |= mask;
        asset.safeTransfer(program.beneficiary, program.dailyAmount);
        emit DailyAllowanceClaimed(programId, dayIndex, program.dailyAmount);
    }

    function withdrawMaturedSavings(uint256 programId) external {
        Program storage program = programs[programId];
        if (program.owner != msg.sender) revert NotProgramOwner();
        if (block.timestamp < uint256(program.startAt) + uint256(program.durationDays) * 1 days + COOLDOWN) {
            revert SavingsStillLocked();
        }

        uint256 remaining = uint256(program.durationDays) * program.dailyAmount - _claimedTotal(program);
        program.claimedBitmap = type(uint256).max;
        if (remaining == 0) return;

        asset.safeTransfer(program.owner, remaining);
        emit SavingsWithdrawn(programId, program.owner, remaining);
    }

    function claimDigest(uint256 programId, address beneficiary, uint16 dayIndex, uint64 validUntil)
        external
        view
        returns (bytes32)
    {
        return _voucherDigest(programId, beneficiary, dayIndex, validUntil);
    }

    function _recoverVoucher(
        uint256 programId,
        address beneficiary,
        uint16 dayIndex,
        uint64 validUntil,
        bytes calldata signature
    ) private view returns (address) {
        return _voucherDigest(programId, beneficiary, dayIndex, validUntil).recover(signature);
    }

    function _voucherDigest(uint256 programId, address beneficiary, uint16 dayIndex, uint64 validUntil)
        private
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(abi.encode(CLAIM_VOUCHER_TYPEHASH, programId, beneficiary, dayIndex, validUntil))
        );
    }

    function _claimedTotal(Program storage program) private view returns (uint256 total) {
        uint256 bitmap = program.claimedBitmap;
        for (uint16 i; i < program.durationDays; ++i) {
            if (bitmap & (1 << i) != 0) total += program.dailyAmount;
        }
    }
}
