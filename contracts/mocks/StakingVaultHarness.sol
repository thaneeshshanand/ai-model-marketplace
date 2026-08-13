// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {StakingVault} from "../StakingVault.sol";

/// @title  StakingVaultHarness
/// @notice Test-only subclass that can force `rewardReserve` to an arbitrary value.
/// @dev    Exists solely to reach the defensive cap in `getReward()` where
///         `reward > rewardReserve`. That branch is unreachable in production:
///         `rewardRate = amount / duration` uses integer division, so the total
///         distributable over a period never exceeds the amount funded, and the
///         leftover rollover in `fundRewards` preserves that property. Rounding always
///         favours the reserve.
///
///         The branch is kept as defence in depth against a future change to the reward
///         maths, and this harness proves it behaves correctly if ever triggered.
///
///         Excluded from the coverage denominator via `.solcover.js`. Never deployed.
contract StakingVaultHarness is StakingVault {
    constructor(
        address stakingToken,
        address admin,
        address treasury_,
        uint256 lockPeriod_,
        uint256 minProviderBond_
    )
        StakingVault(stakingToken, admin, treasury_, lockPeriod_, minProviderBond_)
    // solhint-disable-next-line no-empty-blocks
    {

    }

    /// @notice Overwrite the reward reserve, bypassing `fundRewards`.
    function forceRewardReserve(uint256 newReserve) external {
        rewardReserve = newReserve;
    }
}
