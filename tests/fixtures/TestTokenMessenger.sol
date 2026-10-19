// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

interface ITestToken {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// A stand-in for CCTP V2's TokenMessengerV2 in the spending limit's tests: `depositForBurnWithHook` takes the amount
/// from its caller, as the real one burns it, and keeps the arguments it was called with. `pullShort` makes it take
/// one unit less, to show a contract that would be left holding USDC refuses. Never deployed anywhere.
contract TestTokenMessenger {
    uint256 public lastAmount;
    uint32 public lastDomain;
    bytes32 public lastRecipient;
    address public lastToken;
    bytes32 public lastCaller;
    uint256 public lastMaxFee;
    uint32 public lastFinality;
    bytes32 public lastHook;
    uint256 public hookLength;
    uint256 public burns;
    bool public pullShort;

    function setPullShort(bool short) external {
        pullShort = short;
    }

    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external {
        require(ITestToken(burnToken).transferFrom(msg.sender, address(this), pullShort ? amount - 1 : amount), "pull");
        lastAmount = amount;
        lastDomain = destinationDomain;
        lastRecipient = mintRecipient;
        lastToken = burnToken;
        lastCaller = destinationCaller;
        lastMaxFee = maxFee;
        lastFinality = minFinalityThreshold;
        lastHook = bytes32(hookData);
        hookLength = hookData.length;
        burns += 1;
    }
}
