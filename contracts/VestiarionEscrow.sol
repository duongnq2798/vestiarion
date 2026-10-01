// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// The ERC-20 calls the escrow makes: USDC on Arc testnet answers them at 0x3600…0000.
interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title VestiarionEscrow
/// @notice A workspace's milestone escrow (docs/superpowers/specs/2026-10-01-milestone-escrow-design.md E1).
/// The payer — the workspace's operating wallet — locks a milestone's amount for a payee. Only two things can
/// happen to a hold, once: the payer releases it to its payee, or, from `refundAfter` on, takes it back. Before
/// `refundAfter` the money can go nowhere but to the payee. No owner, no upgrade, nothing else.
/// Written for Arc testnet and not audited.
contract VestiarionEscrow {
    enum State {
        None,
        Funded,
        Released,
        Refunded
    }

    struct Hold {
        address payee;
        uint64 refundAfter;
        State state;
        uint256 amount;
    }

    IERC20Minimal public immutable token;
    address public immutable payer;
    mapping(bytes32 => Hold) public holds;

    event Funded(bytes32 indexed id, address indexed payee, uint256 amount, uint64 refundAfter);
    event Released(bytes32 indexed id, address indexed payee, uint256 amount);
    event Refunded(bytes32 indexed id, address indexed payer, uint256 amount);

    error NotPayer();
    error HoldExists();
    error NotFunded();
    error InvalidHold();
    error TooEarly();
    error TransferFailed();

    constructor(address token_, address payer_) {
        if (token_ == address(0) || payer_ == address(0)) revert InvalidHold();
        token = IERC20Minimal(token_);
        payer = payer_;
    }

    modifier onlyPayer() {
        if (msg.sender != payer) revert NotPayer();
        _;
    }

    /// Locks `amount` for `payee` under `id`, pulled from the payer, which approved this contract first.
    function fund(bytes32 id, address payee, uint256 amount, uint64 refundAfter) external onlyPayer {
        if (holds[id].state != State.None) revert HoldExists();
        if (payee == address(0) || amount == 0) revert InvalidHold();
        holds[id] = Hold({payee: payee, refundAfter: refundAfter, state: State.Funded, amount: amount});
        if (!token.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit Funded(id, payee, amount, refundAfter);
    }

    /// Pays a funded hold to its payee: the only place its money can go before `refundAfter`.
    function release(bytes32 id) external onlyPayer {
        Hold storage hold = holds[id];
        if (hold.state != State.Funded) revert NotFunded();
        hold.state = State.Released;
        if (!token.transfer(hold.payee, hold.amount)) revert TransferFailed();
        emit Released(id, hold.payee, hold.amount);
    }

    /// Returns a funded hold to the payer, from `refundAfter` on.
    function refund(bytes32 id) external onlyPayer {
        Hold storage hold = holds[id];
        if (hold.state != State.Funded) revert NotFunded();
        if (block.timestamp < hold.refundAfter) revert TooEarly();
        hold.state = State.Refunded;
        if (!token.transfer(payer, hold.amount)) revert TransferFailed();
        emit Refunded(id, payer, hold.amount);
    }
}
