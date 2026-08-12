// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title  Ping
/// @author Thaneesh Shanand Lingan Anandakumar
/// @notice Phase 0 toolchain validation contract. Delete before final submission.
/// @dev    This contract is intentionally imperfect. It exists to prove that the
///         toolchain is genuinely analysing code rather than reporting success blindly.
///
///         Two deliberate Slither triggers:
///           1. `owner` is assigned once in the constructor and never changed, so the
///              `immutable-states` optimisation detector should flag it.
///           2. `block.timestamp` drives control flow, so the `timestamp` detector
///              (low severity) should flag it.
///
///         One deliberate coverage gap: `reset()` and the `onlyOwner` revert path are
///         left untested, so `hardhat coverage` must report below 100 percent.
contract Ping {
    /// @notice Deployer address. Not marked immutable on purpose (see @dev).
    address public owner;

    /// @notice Total successful pings.
    uint256 public pingCount;

    /// @notice Timestamp of the most recent successful ping.
    uint256 public lastPingAt;

    /// @notice Minimum seconds between pings.
    uint256 public constant COOLDOWN = 10;

    /// @notice Emitted on every successful ping.
    event Pinged(address indexed caller, uint256 count, uint256 timestamp);

    error NotOwner();
    error TooSoon(uint256 retryAfter);

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Record a ping, subject to the cooldown window.
    function ping() external {
        if (lastPingAt != 0 && block.timestamp < lastPingAt + COOLDOWN) {
            revert TooSoon(lastPingAt + COOLDOWN);
        }
        pingCount += 1;
        lastPingAt = block.timestamp;
        emit Pinged(msg.sender, pingCount, block.timestamp);
    }

    /// @notice Clear all counters. Owner only.
    /// @dev Intentionally left untested in Phase 0 to create a coverage gap.
    function reset() external onlyOwner {
        pingCount = 0;
        lastPingAt = 0;
    }
}
