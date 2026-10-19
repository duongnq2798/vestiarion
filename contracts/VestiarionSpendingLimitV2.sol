// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// The ERC-20 calls the contract makes: USDC on Arc answers them at 0x3600…0000.
interface IERC20SpendingLimit {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

/// CCTP V2's TokenMessengerV2: the one call that burns USDC on Arc for a mint on another chain.
interface ITokenMessengerV2 {
    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external;
}

/// @title VestiarionSpendingLimitV2
/// @notice A workspace's spending limit on Arc, version 2 (docs/superpowers/specs/2026-10-19-spending-limit-v2-cross-
/// chain-design.md V1–V6): everything version 1 does, and `payAcrossChains`, which pays a payee on another chain through
/// CCTP V2 with Circle's Forwarding Service, within the same figures. The agent's wallet holds no money of its own: the
/// contract draws the payment and its fee from the treasury, burns both in the same call, and holds nothing after it.
/// The token messenger and the chains it may burn for are fixed at deployment; the fee is capped. No upgrade, nothing
/// else. Written for Arc and not audited.
contract VestiarionSpendingLimitV2 {
    uint256 public constant VERSION = 2;
    /// The most `maxFee` may be, as a share of the amount: 10%, in basis points.
    uint256 public constant MAX_FEE_BPS = 1000;
    /// The most `maxFee` may be at all: 2 USDC, in the token's units.
    uint256 public constant MAX_FEE_UNITS = 2_000_000;
    /// A fast transfer: attested at "confirmed" finality.
    uint32 public constant FAST_FINALITY = 1000;
    /// The hook data asking Circle's Forwarding Service to submit the mint: "cctp-forward", padded to 32 bytes.
    bytes32 public constant FORWARD_HOOK = 0x636374702d666f72776172640000000000000000000000000000000000000000;

    IERC20SpendingLimit public immutable token;
    address public immutable treasury;
    address public immutable owner;
    address public immutable agent;
    ITokenMessengerV2 public immutable tokenMessenger;
    /// The CCTP domains `payAcrossChains` may burn for, one bit each: bit 6 is Base.
    uint256 public immutable allowedDomains;

    /// In token units; 0 when that figure is not set. At least one is always set.
    uint256 public dailyLimit;
    uint256 public weeklyLimit;

    /// What the agent paid on each UTC day, by day number since the Unix epoch; a payout to another chain with its fee.
    mapping(uint256 => uint256) public spentOn;
    /// The payments already made, by the ref that names each one, whichever function made them.
    mapping(bytes32 => bool) public paid;

    event Paid(bytes32 indexed ref, address indexed to, uint256 amount, uint256 day);
    event PaidAcrossChains(bytes32 indexed ref, uint32 indexed domain, bytes32 recipient, uint256 amount, uint256 maxFee, uint256 day);
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
    error DomainNotAllowed(uint32 domain);
    error FeeTooHigh(uint256 maxFee, uint256 cap);
    error BalanceLeft();

    constructor(
        address token_,
        address treasury_,
        address agent_,
        address tokenMessenger_,
        uint256 allowedDomains_,
        uint256 dailyLimit_,
        uint256 weeklyLimit_
    ) {
        if (token_ == address(0) || treasury_ == address(0) || agent_ == address(0) || tokenMessenger_ == address(0)) revert InvalidSetup();
        token = IERC20SpendingLimit(token_);
        treasury = treasury_;
        owner = treasury_;
        agent = agent_;
        tokenMessenger = ITokenMessengerV2(tokenMessenger_);
        allowedDomains = allowedDomains_;
        _setLimits(dailyLimit_, weeklyLimit_);
    }

    /// Pays `amount` from the treasury to `to`, for the agent, within both figures; `ref` names the payment.
    function pay(address to, uint256 amount, bytes32 ref) external {
        if (msg.sender != agent) revert NotAgent();
        if (to == address(0) || amount == 0) revert InvalidPayment();
        uint256 day = _spend(amount, ref);
        if (!token.transferFrom(treasury, to, amount)) revert TransferFailed();
        emit Paid(ref, to, amount, day);
    }

    /// Pays `amount` to `recipient` on the chain of CCTP domain `domain`, for the agent: the treasury pays `amount` and
    /// `maxFee`, both counted against the figures, and both are burned here with the forwarding hook. The recipient is
    /// minted `amount` and whatever of `maxFee` the transfer does not charge.
    function payAcrossChains(uint256 amount, uint256 maxFee, uint32 domain, bytes32 recipient, bytes32 ref) external {
        if (msg.sender != agent) revert NotAgent();
        if (recipient == bytes32(0) || amount == 0) revert InvalidPayment();
        if (allowedDomains & (uint256(1) << domain) == 0) revert DomainNotAllowed(domain);
        uint256 cap = (amount * MAX_FEE_BPS) / 10_000;
        if (cap > MAX_FEE_UNITS) cap = MAX_FEE_UNITS;
        if (maxFee > cap) revert FeeTooHigh(maxFee, cap);
        uint256 total = amount + maxFee;
        uint256 day = _spend(total, ref);
        uint256 held = token.balanceOf(address(this));
        if (!token.transferFrom(treasury, address(this), total)) revert TransferFailed();
        if (!token.approve(address(tokenMessenger), total)) revert TransferFailed();
        tokenMessenger.depositForBurnWithHook(total, domain, recipient, address(token), bytes32(0), maxFee, FAST_FINALITY, abi.encodePacked(FORWARD_HOOK));
        if (token.balanceOf(address(this)) != held || token.allowance(address(this), address(tokenMessenger)) != 0) revert BalanceLeft();
        emit PaidAcrossChains(ref, domain, recipient, amount, maxFee, day);
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

    /// Counts `amount` against both figures for today and marks `ref` paid, or refuses; returns today's day number.
    function _spend(uint256 amount, bytes32 ref) private returns (uint256 day) {
        if (paid[ref]) revert AlreadyPaid(ref);
        day = block.timestamp / 1 days;
        uint256 today = spentOn[day];
        if (dailyLimit != 0 && today + amount > dailyLimit) revert OverDailyLimit(today, amount, dailyLimit);
        if (weeklyLimit != 0) {
            uint256 week = _spentInWeekOf(day);
            if (week + amount > weeklyLimit) revert OverWeeklyLimit(week, amount, weeklyLimit);
        }
        paid[ref] = true;
        spentOn[day] = today + amount;
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
