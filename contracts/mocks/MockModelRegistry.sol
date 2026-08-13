// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title  MockModelRegistry
/// @notice Test double for the ModelRegistry views consumed by PerformanceOracle and
///         Marketplace.
/// @dev    Lets tests set a provider, listability and risk tier directly instead of
///         driving bonding and registration flows in every fixture. Excluded from the
///         coverage denominator via `.solcover.js`. Never deployed.
contract MockModelRegistry {
    mapping(uint256 modelId => address provider) public providers;
    mapping(uint256 modelId => bool listable) public listable;
    mapping(uint256 modelId => bool highRisk) public highRisk;

    function setModel(uint256 modelId, address provider, bool listable_, bool highRisk_) external {
        providers[modelId] = provider;
        listable[modelId] = listable_;
        highRisk[modelId] = highRisk_;
    }

    function setListable(uint256 modelId, bool value) external {
        listable[modelId] = value;
    }

    function getModelProvider(uint256 modelId) external view returns (address) {
        return providers[modelId];
    }

    function isListable(uint256 modelId) external view returns (bool) {
        return listable[modelId];
    }

    function isHighRisk(uint256 modelId) external view returns (bool) {
        return highRisk[modelId];
    }
}
