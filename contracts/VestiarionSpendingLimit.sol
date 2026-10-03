// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// The ERC-20 call the contract makes: USDC on Arc testnet answers it at 0x3600…0000.
interface IERC20TransferFrom {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title VestiarionSpendingLimit
/// @notice A workspace's spending limit on Arc (docs/superpowers/specs/2026-10-03-onchain-spending-limit-design.md §2).
/// The agent's payments leave the treasury through `pay`, and only through it: the agent's wallet holds no money of
/// its own. `pay` refuses anything past the daily figure (the current UTC day) or the 7-day figure (that day and the
/// six before it), and pays each ref once. The money stays in the treasury, which approves this contract; only the
/// owner, the treasury itself, changes the figures. No upgrade, nothing else.
/// Written for Arc testnet and not audited.
contract VestiarionSpendingLimit {
    IERC20TransferFrom public immutable token;
    address public immutable treasury;
    address public immutable owner;
    address public immutable agent;

    /// In token units; 0 when that figure is not set. At least one is always set.
    uint256 public dailyLimit;
    uint256 public weeklyLimit;

    /// What the agent paid on each UTC day, by day number since the Unix epoch.
    mapping(uint256 => uint256) public spentOn;
    /// The payments already made, by the ref that names each one.
    mapping(bytes32 => bool) public paid;

    event Paid(bytes32 indexed ref, address indexed to, uint256 amount, uint256 day);
    event LimitsSet(uint256 dailyLimit, uint256 weeklyLimit);

    error NotAgent();
    error NotOwner();
    error OverDailyLimit(uint256 spent, uint256 amount, uint256 limit);
    error OverWeeklyLimit(uint256 spent, uint256 amount, uint256 limit);
    error AlreadyPaid(bytes32 ref);
    error InvalidLimits();
    error InvalidPayment();
    error InvalidSetup();
    error TransferFailed();

    constructor(address token_, address treasury_, address agent_, uint256 dailyLimit_, uint256 weeklyLimit_) {
        if (token_ == address(0) || treasury_ == address(0) || agent_ == address(0)) revert InvalidSetup();
        token = IERC20TransferFrom(token_);
        treasury = treasury_;
        owner = treasury_;
        agent = agent_;
        _setLimits(dailyLimit_, weeklyLimit_);
    }

    /// Pays `amount` from the treasury to `to`, for the agent, within both figures; `ref` names the payment.
    function pay(address to, uint256 amount, bytes32 ref) external {
        if (msg.sender != agent) revert NotAgent();
        if (to == address(0) || amount == 0) revert InvalidPayment();
        if (paid[ref]) revert AlreadyPaid(ref);
        uint256 day = block.timestamp / 1 days;
        uint256 today = spentOn[day];
        if (dailyLimit != 0 && today + amount > dailyLimit) revert OverDailyLimit(today, amount, dailyLimit);
        if (weeklyLimit != 0) {
            uint256 week = _spentInWeekOf(day);
            if (week + amount > weeklyLimit) revert OverWeeklyLimit(week, amount, weeklyLimit);
        }
        paid[ref] = true;
        spentOn[day] = today + amount;
        if (!token.transferFrom(treasury, to, amount)) revert TransferFailed();
        emit Paid(ref, to, amount, day);
    }

    /// The owner's: new figures, which apply to the next payment.
    function setLimits(uint256 dailyLimit_, uint256 weeklyLimit_) external {
        if (msg.sender != owner) revert NotOwner();
        _setLimits(dailyLimit_, weeklyLimit_);
    }

    /// What the agent paid today (UTC).
    function spentToday() external view returns (uint256) {
        return spentOn[block.timestamp / 1 days];
    }

    /// What the agent paid today and in the six UTC days before it.
    function spentThisWeek() external view returns (uint256) {
        return _spentInWeekOf(block.timestamp / 1 days);
    }

    function _spentInWeekOf(uint256 day) private view returns (uint256 total) {
        for (uint256 back = 0; back < 7 && back <= day; back++) {
            total += spentOn[day - back];
        }
    }

    function _setLimits(uint256 dailyLimit_, uint256 weeklyLimit_) private {
        if (dailyLimit_ == 0 && weeklyLimit_ == 0) revert InvalidLimits();
        if (dailyLimit_ != 0 && weeklyLimit_ != 0 && weeklyLimit_ < dailyLimit_) revert InvalidLimits();
        dailyLimit = dailyLimit_;
        weeklyLimit = weeklyLimit_;
        emit LimitsSet(dailyLimit_, weeklyLimit_);
    }
}
