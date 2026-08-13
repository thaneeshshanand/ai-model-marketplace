// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title  MockStakingBond
/// @notice Test double for the StakingVault bond check.
/// @dev    Lets ModelRegistry tests toggle bonded status directly, including simulating a
///         provider slashed below the threshold after listing. Using the real vault would
///         require staking flows in every test and couple two contracts' failures together.
///         Excluded from the coverage denominator via `.solcover.js`. Never deployed.
contract MockStakingBond {
    mapping(address account => bool bonded) public bonded;

    function setBonded(address account, bool value) external {
        bonded[account] = value;
    }

    function isBondedProvider(address account) external view returns (bool) {
        return bonded[account];
    }
}
