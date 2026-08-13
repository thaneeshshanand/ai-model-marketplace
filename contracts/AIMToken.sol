// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title  AIMToken
/// @author Thaneesh Shanand Lingan Anandakumar
/// @notice Utility and governance token for the AI Model Marketplace (AIMM).
/// @dev    Design decisions, all defended in the technical report:
///
///         1. FIXED SUPPLY, NO MINT FUNCTION. The entire supply is minted in the
///            constructor and `_mint` is never reachable again. There is no owner,
///            no minter role, and no upgrade path. This removes the infinite-mint
///            surface that accounts for a large share of token exploits.
///
///         2. NO ERC20Votes. Governance weight is derived from *staked* balance via
///            `StakingVault.votingPowerAt`, not from token balance. Checkpointing is
///            therefore unnecessary, and flash-loan governance attacks are structurally
///            impossible because voting weight requires a stake that predates the
///            proposal. See StakingVault for the mechanism.
///
///         3. NO PAUSE, NO BLOCKLIST, NO TRANSFER HOOKS. The token is deliberately
///            inert. All protocol logic lives in contracts that hold it. A token that
///            cannot be frozen is a stronger guarantee to enterprise counterparties
///            than one that can.
///
///         4. VESTING IS DOCUMENTED, NOT ENFORCED ON-CHAIN. Allocations are minted to
///            distinct addresses so that on-chain accounting is transparent from block
///            zero. Cliff and vesting schedules are specified in docs/TOKENOMICS.md and
///            are a documented roadmap item rather than deployed code.
contract AIMToken is ERC20 {
    /// @notice Total supply, fixed permanently at deployment. 1,000,000,000 AIM.
    uint256 public constant MAX_SUPPLY = 1_000_000_000 ether;

    /// @notice Staking rewards allocation. 35 percent.
    uint256 public constant STAKING_REWARDS_ALLOCATION = 350_000_000 ether;

    /// @notice Protocol treasury allocation. 25 percent.
    uint256 public constant TREASURY_ALLOCATION = 250_000_000 ether;

    /// @notice Team allocation. 15 percent.
    uint256 public constant TEAM_ALLOCATION = 150_000_000 ether;

    /// @notice Investor allocation. 15 percent.
    uint256 public constant INVESTOR_ALLOCATION = 150_000_000 ether;

    /// @notice Liquidity provisioning allocation. 10 percent.
    uint256 public constant LIQUIDITY_ALLOCATION = 100_000_000 ether;

    /// @notice Thrown when any allocation recipient is the zero address.
    error ZeroAddress(string recipient);

    /// @param stakingRewardsPool Receives the staking rewards allocation. Expected to be
    ///        an operations address that later funds StakingVault via `fundRewards`.
    /// @param treasury           Receives the treasury allocation.
    /// @param team               Receives the team allocation.
    /// @param investors          Receives the investor allocation.
    /// @param liquidity          Receives the liquidity allocation.
    constructor(
        address stakingRewardsPool,
        address treasury,
        address team,
        address investors,
        address liquidity
    ) ERC20("AI Marketplace Token", "AIM") {
        if (stakingRewardsPool == address(0)) revert ZeroAddress("stakingRewardsPool");
        if (treasury == address(0)) revert ZeroAddress("treasury");
        if (team == address(0)) revert ZeroAddress("team");
        if (investors == address(0)) revert ZeroAddress("investors");
        if (liquidity == address(0)) revert ZeroAddress("liquidity");

        _mint(stakingRewardsPool, STAKING_REWARDS_ALLOCATION);
        _mint(treasury, TREASURY_ALLOCATION);
        _mint(team, TEAM_ALLOCATION);
        _mint(investors, INVESTOR_ALLOCATION);
        _mint(liquidity, LIQUIDITY_ALLOCATION);

        // Compile-time arithmetic guarantees this holds, but the assertion documents
        // the invariant for auditors and would catch a future edit to the constants.
        assert(totalSupply() == MAX_SUPPLY);
    }
}
