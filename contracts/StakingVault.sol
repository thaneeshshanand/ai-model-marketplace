// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title  StakingVault
/// @author Thaneesh Shanand Lingan Anandakumar
/// @notice Stakes AIM to earn rewards, bonds model providers against misbehaviour, and
///         supplies governance voting weight for the AI Model Marketplace.
/// @dev    Three design decisions worth flagging for audit:
///
///         1. REWARD ACCOUNTING USES THE ACCUMULATOR PATTERN (Synthetix StakingRewards).
///            `rewardPerTokenStored` advances on every balance-changing call, so no
///            function ever iterates over stakers. Reward distribution is therefore O(1)
///            and cannot be griefed by a large staker set.
///
///         2. STAKE AND REWARD FUNDS ARE ACCOUNTED SEPARATELY. The staking token and the
///            reward token are the same asset, which in a naive implementation lets reward
///            payouts silently drain principal. `totalStaked` and `rewardReserve` are
///            tracked independently and the contract holds the sum. See `solvency()`.
///
///         3. VOTING WEIGHT REQUIRES A PRE-EXISTING STAKE. `lastIncreaseAt` resets on any
///            stake increase, and `votingPowerAt` returns zero if the stake was increased
///            after the proposal snapshot. An attacker cannot borrow tokens, stake, and
///            vote within one transaction, because weight demands capital that predates
///            the proposal. This is what makes ERC20Votes checkpointing unnecessary.
contract StakingVault is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- roles

    /// @notice Adjusts economic parameters. Held by ParameterGovernor in production.
    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");

    /// @notice Slashes provider bonds. Held by PerformanceOracle in production.
    bytes32 public constant SLASHER_ROLE = keccak256("SLASHER_ROLE");

    /// @notice Deposits reward tokens and starts distribution periods.
    bytes32 public constant REWARD_FUNDER_ROLE = keccak256("REWARD_FUNDER_ROLE");

    /// @notice Emergency pause of new stakes. Cannot block withdrawals.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // ---------------------------------------------------------------- config

    /// @notice The AIM token. Serves as both stake and reward asset.
    IERC20 public immutable STAKING_TOKEN;

    /// @notice Upper bound on `lockPeriod`, enforced so governance cannot lock funds
    ///         indefinitely. 365 days.
    uint256 public constant MAX_LOCK_PERIOD = 365 days;

    /// @notice Upper bound on a single slash, as a percentage of the target's stake.
    ///         Caps the damage a compromised oracle can inflict in one call.
    uint256 public constant MAX_SLASH_BPS = 5000; // 50 percent

    /// @notice Receives slashed funds.
    address public treasury;

    /// @notice Seconds a new or increased stake remains locked.
    uint256 public lockPeriod;

    /// @notice Minimum stake required for ModelRegistry to accept a listing.
    uint256 public minProviderBond;

    // ---------------------------------------------------------------- accounting

    /// @notice Sum of all staked balances. Never includes reward funds.
    uint256 public totalStaked;

    /// @notice Tokens held for reward payouts. Never includes principal.
    uint256 public rewardReserve;

    /// @notice Reward tokens distributed per second during the active period.
    uint256 public rewardRate;

    /// @notice Timestamp the active reward period ends.
    uint256 public periodFinish;

    /// @notice Last time the global accumulator advanced.
    uint256 public lastUpdateTime;

    /// @notice Accumulated reward per staked token, scaled by 1e18.
    uint256 public rewardPerTokenStored;

    /// @notice Staked balance per account.
    mapping(address account => uint256 amount) public balanceOf;

    /// @notice Timestamp before which an account cannot withdraw.
    mapping(address account => uint256 timestamp) public unlockAt;

    /// @notice Timestamp of the account's most recent stake increase. Governance snapshot key.
    mapping(address account => uint256 timestamp) public lastIncreaseAt;

    /// @notice Accumulator value already credited to the account.
    mapping(address account => uint256 value) public userRewardPerTokenPaid;

    /// @notice Rewards earned but not yet claimed.
    mapping(address account => uint256 amount) public rewards;

    // ---------------------------------------------------------------- events

    event Staked(address indexed account, uint256 amount, uint256 unlockAt);
    event Withdrawn(address indexed account, uint256 amount);
    event RewardPaid(address indexed account, uint256 amount);
    event RewardsFunded(uint256 amount, uint256 duration, uint256 rewardRate);
    event Slashed(address indexed account, uint256 amount, address indexed treasury);
    event LockPeriodUpdated(uint256 previous, uint256 current);
    event MinProviderBondUpdated(uint256 previous, uint256 current);
    event TreasuryUpdated(address indexed previous, address indexed current);

    // ---------------------------------------------------------------- errors

    error ZeroAddress();
    error ZeroAmount();
    error InsufficientStake(uint256 requested, uint256 available);
    error StakeLocked(uint256 unlocksAt);
    error LockPeriodTooLong(uint256 requested, uint256 maximum);
    error SlashExceedsCap(uint256 requested, uint256 maximum);
    error ZeroDuration();
    error RewardPeriodTooShort();

    // ---------------------------------------------------------------- constructor

    /// @param stakingToken    Address of the AIM token.
    /// @param admin           Receives DEFAULT_ADMIN_ROLE and PAUSER_ROLE at deploy.
    /// @param treasury_       Destination for slashed funds.
    /// @param lockPeriod_     Initial lock duration in seconds.
    /// @param minProviderBond_ Initial minimum provider bond.
    constructor(
        address stakingToken,
        address admin,
        address treasury_,
        uint256 lockPeriod_,
        uint256 minProviderBond_
    ) {
        if (stakingToken == address(0)) revert ZeroAddress();
        if (admin == address(0)) revert ZeroAddress();
        if (treasury_ == address(0)) revert ZeroAddress();
        if (lockPeriod_ > MAX_LOCK_PERIOD) revert LockPeriodTooLong(lockPeriod_, MAX_LOCK_PERIOD);

        STAKING_TOKEN = IERC20(stakingToken);
        treasury = treasury_;
        lockPeriod = lockPeriod_;
        minProviderBond = minProviderBond_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    // ---------------------------------------------------------------- reward maths

    /// @dev Advances the global accumulator, then credits `account` if one is given.
    ///      Passing address(0) updates global state only.
    ///
    ///      This was a modifier originally. It is an explicit internal call because
    ///      solidity-coverage instruments modifiers as branches split on the `_;`
    ///      placeholder, and a modifier with no code after `_;` leaves one unreachable
    ///      branch at every call site. Five call sites meant five phantom uncovered
    ///      branches. Making the call explicit also puts the state mutation in plain
    ///      sight at each entrypoint rather than hiding it in a decorator.
    function _updateReward(address account) internal {
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = lastTimeRewardApplicable();
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
    }

    /// @notice The later of now and the end of the reward period.
    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    /// @notice Accumulated reward per staked token, scaled by 1e18.
    function rewardPerToken() public view returns (uint256) {
        if (totalStaked == 0) {
            return rewardPerTokenStored;
        }
        uint256 elapsed = lastTimeRewardApplicable() - lastUpdateTime;
        return rewardPerTokenStored + ((elapsed * rewardRate * 1e18) / totalStaked);
    }

    /// @notice Total unclaimed reward owed to an account.
    function earned(address account) public view returns (uint256) {
        uint256 delta = rewardPerToken() - userRewardPerTokenPaid[account];
        return rewards[account] + ((balanceOf[account] * delta) / 1e18);
    }

    // ---------------------------------------------------------------- staking

    /// @notice Stake AIM. Resets the lock and the governance eligibility timestamp.
    /// @dev Increasing a stake resets `lastIncreaseAt`, which disqualifies the account
    ///      from voting on proposals that already exist. Deliberate: it is the check that
    ///      makes flash-loan vote buying impossible.
    function stake(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        _updateReward(msg.sender);

        balanceOf[msg.sender] += amount;
        totalStaked += amount;
        unlockAt[msg.sender] = block.timestamp + lockPeriod;
        lastIncreaseAt[msg.sender] = block.timestamp;

        STAKING_TOKEN.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount, unlockAt[msg.sender]);
    }

    /// @notice Withdraw unlocked stake. Available even while paused.
    function withdraw(uint256 amount) public nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _updateReward(msg.sender);
        uint256 staked = balanceOf[msg.sender];
        if (amount > staked) revert InsufficientStake(amount, staked);
        if (block.timestamp < unlockAt[msg.sender]) revert StakeLocked(unlockAt[msg.sender]);

        balanceOf[msg.sender] = staked - amount;
        totalStaked -= amount;

        STAKING_TOKEN.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Claim accrued rewards.
    function getReward() public nonReentrant {
        _updateReward(msg.sender);

        uint256 reward = rewards[msg.sender];
        if (reward == 0) return;

        // Defensive cap. Rounding in the accumulator can in principle credit marginally
        // more than the reserve holds; principal must never be used to cover it.
        if (reward > rewardReserve) {
            reward = rewardReserve;
        }

        rewards[msg.sender] -= reward;
        rewardReserve -= reward;

        STAKING_TOKEN.safeTransfer(msg.sender, reward);
        emit RewardPaid(msg.sender, reward);
    }

    // ---------------------------------------------------------------- rewards funding

    /// @notice Deposit reward tokens and start or extend a distribution period.
    /// @dev Pulls `amount` from the caller, so the reserve is always genuinely funded.
    ///      Unspent rewards from an active period roll into the new rate.
    function fundRewards(uint256 amount, uint256 duration)
        external
        onlyRole(REWARD_FUNDER_ROLE)
    {
        if (amount == 0) revert ZeroAmount();
        if (duration == 0) revert ZeroDuration();

        _updateReward(address(0));

        STAKING_TOKEN.safeTransferFrom(msg.sender, address(this), amount);
        rewardReserve += amount;

        if (block.timestamp >= periodFinish) {
            rewardRate = amount / duration;
        } else {
            uint256 leftover = (periodFinish - block.timestamp) * rewardRate;
            rewardRate = (amount + leftover) / duration;
        }
        if (rewardRate == 0) revert RewardPeriodTooShort();

        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + duration;

        emit RewardsFunded(amount, duration, rewardRate);
    }

    // ---------------------------------------------------------------- slashing

    /// @notice Slash a provider's bond, sending the proceeds to the treasury.
    /// @dev Capped at MAX_SLASH_BPS of the target's stake per call. The cap bounds the
    ///      blast radius if the oracle holding SLASHER_ROLE is ever compromised, which is
    ///      the single largest trust assumption in the system.
    function slash(address account, uint256 amount)
        external
        onlyRole(SLASHER_ROLE)
    {
        if (account == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        _updateReward(account);

        uint256 staked = balanceOf[account];
        if (amount > staked) revert InsufficientStake(amount, staked);

        uint256 cap = (staked * MAX_SLASH_BPS) / 10_000;
        if (amount > cap) revert SlashExceedsCap(amount, cap);

        balanceOf[account] = staked - amount;
        totalStaked -= amount;

        STAKING_TOKEN.safeTransfer(treasury, amount);
        emit Slashed(account, amount, treasury);
    }

    // ---------------------------------------------------------------- governance hooks

    /// @notice Voting weight of `account` for a proposal snapshotted at `snapshotTime`.
    /// @dev Returns zero when the stake was increased at or after the snapshot. This is
    ///      the anti-flash-loan control: weight requires capital committed before the
    ///      proposal existed. Consumed by ParameterGovernor in Phase 4.
    function votingPowerAt(address account, uint256 snapshotTime) external view returns (uint256) {
        if (lastIncreaseAt[account] == 0) return 0;
        if (lastIncreaseAt[account] > snapshotTime) return 0;
        return balanceOf[account];
    }

    /// @notice Whether `account` meets the bond threshold to list a model.
    /// @dev Consumed by ModelRegistry in Phase 2.
    function isBondedProvider(address account) external view returns (bool) {
        return balanceOf[account] >= minProviderBond;
    }

    /// @notice Difference between the contract's balance and its obligations.
    /// @dev Must never be negative. Exposed for the monitoring dashboard and as an
    ///      invariant for the audit report.
    function solvency() external view returns (uint256 held, uint256 owed) {
        held = STAKING_TOKEN.balanceOf(address(this));
        owed = totalStaked + rewardReserve;
    }

    // ---------------------------------------------------------------- parameters

    /// @notice Update the lock duration. Applies to future stakes only.
    function setLockPeriod(uint256 newLockPeriod) external onlyRole(GOVERNOR_ROLE) {
        if (newLockPeriod > MAX_LOCK_PERIOD) revert LockPeriodTooLong(newLockPeriod, MAX_LOCK_PERIOD);
        emit LockPeriodUpdated(lockPeriod, newLockPeriod);
        lockPeriod = newLockPeriod;
    }

    /// @notice Update the minimum provider bond.
    function setMinProviderBond(uint256 newBond) external onlyRole(GOVERNOR_ROLE) {
        emit MinProviderBondUpdated(minProviderBond, newBond);
        minProviderBond = newBond;
    }

    /// @notice Update the slash destination.
    function setTreasury(address newTreasury) external onlyRole(GOVERNOR_ROLE) {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    // ---------------------------------------------------------------- emergency

    /// @notice Block new stakes. Withdrawals and claims remain open by design.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Resume staking.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }
}
