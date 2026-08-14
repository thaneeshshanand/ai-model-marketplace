// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice Minimal view of StakingVault used for voting weight and quorum.
interface IStakingVotes {
    function votingPowerAt(address account, uint256 snapshotTime) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function totalStaked() external view returns (uint256);
}

/// @title  ParameterGovernor
/// @author Thaneesh Shanand Lingan Anandakumar
/// @notice Stake-weighted governance over protocol parameters across the AI Model
///         Marketplace contracts.
/// @dev    Design positions defended in the technical report:
///
///         1. VOTING WEIGHT COMES FROM STAKE, NOT TOKEN BALANCE. Weight is read from
///            StakingVault.votingPowerAt(account, snapshotTime), which returns zero if the
///            account increased its stake at or after the snapshot. A flash loan cannot
///            retroactively have existed, so vote buying within a transaction is
///            structurally impossible and no ERC20Votes checkpointing is required.
///            Beanstalk lost roughly $182M in April 2022 to precisely the attack this
///            prevents.
///
///            Known property, documented rather than fixed: a voter may unstake after
///            casting, so a tally can include weight no longer at risk by execution time.
///            Transferring tokens does not enable double voting, because the recipient's
///            `lastIncreaseAt` would postdate the snapshot and their weight would be zero.
///
///         2. NO SEPARATE TIMELOCK CONTRACT. The execution delay is a timestamp derived
///            from the proposal, giving the same guarantee as a TimelockController with
///            half the deployment wiring and none of the cross-contract role choreography.
///
///         3. TARGETS ARE FIXED AT CONSTRUCTION. The four parameterised contracts are
///            known at deploy time and there is no setter. Governance amending its own
///            allowlist would reintroduce the recursion problem this contract is careful
///            to bound. Execution uses `call`, so the blast radius is exactly the blast
///            radius of GOVERNOR_ROLE on those four contracts: it cannot mint, cannot
///            touch escrow, cannot slash, cannot grant roles.
///
///         4. SELF-GOVERNANCE IS BOUNDED BY FLOORS, NOT CEILINGS. Governance may change
///            its own quorum, voting period and execution delay, but never below
///            MIN_QUORUM_BPS, MIN_VOTING_PERIOD or MIN_EXECUTION_DELAY. Ceilings are
///            deliberately absent: governance making itself more conservative is not the
///            attack, so bounding that direction would be symmetry for its own sake.
///
///            The floors are set at demonstration values (5 minutes) rather than
///            production values (days) so that a complete propose-vote-execute cycle is
///            observable on a testnet in one sitting. What the floor guarantees is
///            structural: no proposal, and no captured governance, can reduce the delay to
///            zero. The appropriate deployed values are stated in the deployment runbook.
///
///         5. PROPOSAL STATE IS DERIVED, NOT STORED. `state()` computes from timestamps
///            and tallies. No transition writes exist, so no transition can be missed.
///
///         6. RESIDUAL RISK, STATED PLAINLY. This contract holds GOVERNOR_ROLE on four
///            contracts. A governance deadlock freezes those parameters permanently. The
///            floors reduce the likelihood; the actual mitigation is that
///            DEFAULT_ADMIN_ROLE on the target contracts remains with a multisig as
///            break-glass. That is genuine centralisation and is recorded as accepted risk.
contract ParameterGovernor is AccessControl {
    /// @notice Basis-point denominator.
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Quorum may never fall below 4 percent of staked supply.
    uint256 public constant MIN_QUORUM_BPS = 400;

    /// @notice Voting may never be shorter than five minutes.
    /// @dev Deliberately short so a full governance cycle is demonstrable live on testnet.
    ///      Production deployments should pass a votingPeriod of 3 to 7 days; the floor
    ///      exists to guarantee the delay can never be removed entirely, not to set policy.
    ///      This mirrors the treatment of PerformanceOracle.challengeWindow.
    uint256 public constant MIN_VOTING_PERIOD = 5 minutes;

    /// @notice Execution may never follow success by less than five minutes.
    /// @dev Same reasoning. Production should pass 2 days. The floor guarantees a
    ///      non-zero reaction window exists between a proposal passing and taking effect.
    uint256 public constant MIN_EXECUTION_DELAY = 5 minutes;

    /// @notice Derived lifecycle. Never stored.
    enum ProposalState {
        Active,
        Defeated,
        Succeeded,
        Executed
    }

    /// @notice Vote direction. Abstain counts toward quorum without endorsing.
    enum VoteType {
        Against,
        For,
        Abstain
    }

    /// @param proposer      Address that created the proposal.
    /// @param target        Contract the proposal calls. Must be in the fixed target set.
    /// @param data          Calldata executed on success.
    /// @param snapshotTime  Timestamp voting weight is measured against.
    /// @param voteEnd       Timestamp voting closes.
    /// @param quorumVotes   Absolute quorum, fixed at creation from staked supply.
    /// @param forVotes      Weight in favour.
    /// @param againstVotes  Weight against.
    /// @param abstainVotes  Weight abstaining. Counts toward quorum only.
    /// @param executed      True once executed.
    struct Proposal {
        address proposer;
        address target;
        bytes data;
        uint256 snapshotTime;
        uint256 voteEnd;
        uint256 quorumVotes;
        uint256 forVotes;
        uint256 againstVotes;
        uint256 abstainVotes;
        bool executed;
    }

    /// @notice Source of voting weight and staked supply.
    IStakingVotes public immutable STAKING_VAULT;

    /// @notice Seconds voting remains open.
    uint256 public votingPeriod;

    /// @notice Seconds after voting closes before a successful proposal may execute.
    uint256 public executionDelay;

    /// @notice Quorum as basis points of staked supply at proposal creation.
    uint256 public quorumBps;

    /// @notice Minimum stake required to create a proposal.
    uint256 public proposalThreshold;

    /// @notice Monotonic proposal counter. First proposal is 1.
    uint256 public proposalCount;

    /// @notice Proposals by id.
    mapping(uint256 proposalId => Proposal proposal) public proposals;

    /// @notice Whether an account has voted on a proposal.
    mapping(uint256 proposalId => mapping(address voter => bool)) public hasVoted;

    /// @notice Contracts governance may call. Fixed at construction.
    mapping(address target => bool allowed) public isTarget;

    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        address indexed target,
        bytes data,
        uint256 snapshotTime,
        uint256 voteEnd,
        uint256 quorumVotes
    );
    event VoteCast(uint256 indexed proposalId, address indexed voter, VoteType support, uint256 weight);
    event ProposalExecuted(uint256 indexed proposalId, address indexed executor);
    event ParameterUpdated(string name, uint256 previous, uint256 current);

    error ZeroAddress();
    error EmptyTargetSet();
    error TargetNotAllowed(address target);
    error EmptyCalldata();
    error InsufficientProposerStake(uint256 have, uint256 need);
    error NoProposal(uint256 proposalId);
    error VotingClosed(uint256 voteEnd);
    error VotingOpen(uint256 voteEnd);
    error AlreadyVoted(uint256 proposalId, address voter);
    error NoVotingPower(address voter);
    error ProposalNotSucceeded(uint256 proposalId);
    error ExecutionDelayNotElapsed(uint256 executableAt);
    error ProposalAlreadyExecuted(uint256 proposalId);
    error ExecutionFailed(uint256 proposalId);
    error NoStakedSupply();
    error BelowFloor(uint256 requested, uint256 floor);
    error NotGovernor(address caller);

    /// @param admin             Receives DEFAULT_ADMIN_ROLE. Break-glass only; this role
    ///                          cannot create, vote on, or execute proposals.
    /// @param stakingVault      StakingVault address.
    /// @param targets           Fixed set of governable contracts.
    /// @param votingPeriod_     Initial voting duration.
    /// @param executionDelay_   Initial execution delay.
    /// @param quorumBps_        Initial quorum in basis points of staked supply.
    /// @param proposalThreshold_ Initial minimum stake to propose.
    constructor(
        address admin,
        address stakingVault,
        address[] memory targets,
        uint256 votingPeriod_,
        uint256 executionDelay_,
        uint256 quorumBps_,
        uint256 proposalThreshold_
    ) {
        if (admin == address(0)) revert ZeroAddress();
        if (stakingVault == address(0)) revert ZeroAddress();
        if (targets.length == 0) revert EmptyTargetSet();
        if (votingPeriod_ < MIN_VOTING_PERIOD) revert BelowFloor(votingPeriod_, MIN_VOTING_PERIOD);
        if (executionDelay_ < MIN_EXECUTION_DELAY) {
            revert BelowFloor(executionDelay_, MIN_EXECUTION_DELAY);
        }
        if (quorumBps_ < MIN_QUORUM_BPS) revert BelowFloor(quorumBps_, MIN_QUORUM_BPS);

        STAKING_VAULT = IStakingVotes(stakingVault);
        votingPeriod = votingPeriod_;
        executionDelay = executionDelay_;
        quorumBps = quorumBps_;
        proposalThreshold = proposalThreshold_;

        for (uint256 i = 0; i < targets.length; i++) {
            if (targets[i] == address(0)) revert ZeroAddress();
            isTarget[targets[i]] = true;
        }

        // The governor is a target of itself, which is the only way the self-governance
        // setters are reachable: they require msg.sender == address(this), so they can be
        // called only through `execute`, and therefore only by a passed proposal.
        isTarget[address(this)] = true;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ---------------------------------------------------------------- proposals

    /// @notice Create a proposal to call `target` with `data`.
    /// @dev Quorum is fixed at creation from staked supply, so it scales with
    ///      participation instead of being a stale absolute number. `snapshotTime` is now,
    ///      which combined with `votingPowerAt` means only stake committed before this
    ///      moment can vote.
    function propose(address target, bytes calldata data) external returns (uint256 proposalId) {
        if (!isTarget[target]) revert TargetNotAllowed(target);
        if (data.length == 0) revert EmptyCalldata();

        uint256 stake = STAKING_VAULT.balanceOf(msg.sender);
        if (stake < proposalThreshold) revert InsufficientProposerStake(stake, proposalThreshold);

        uint256 totalStaked = STAKING_VAULT.totalStaked();
        if (totalStaked == 0) revert NoStakedSupply();

        uint256 quorumVotes = (totalStaked * quorumBps) / BPS_DENOMINATOR;
        uint256 voteEnd = block.timestamp + votingPeriod;

        proposalId = ++proposalCount;
        Proposal storage p = proposals[proposalId];
        p.proposer = msg.sender;
        p.target = target;
        p.data = data;
        p.snapshotTime = block.timestamp;
        p.voteEnd = voteEnd;
        p.quorumVotes = quorumVotes;

        emit ProposalCreated(
            proposalId,
            msg.sender,
            target,
            data,
            block.timestamp,
            voteEnd,
            quorumVotes
        );
    }

    /// @notice Cast a vote. Weight is the voter's stake as of the proposal snapshot.
    function castVote(uint256 proposalId, VoteType support) external {
        Proposal storage p = _requireProposal(proposalId);
        if (block.timestamp > p.voteEnd) revert VotingClosed(p.voteEnd);
        if (hasVoted[proposalId][msg.sender]) revert AlreadyVoted(proposalId, msg.sender);

        uint256 weight = STAKING_VAULT.votingPowerAt(msg.sender, p.snapshotTime);
        if (weight == 0) revert NoVotingPower(msg.sender);

        hasVoted[proposalId][msg.sender] = true;

        if (support == VoteType.For) {
            p.forVotes += weight;
        } else if (support == VoteType.Against) {
            p.againstVotes += weight;
        } else {
            p.abstainVotes += weight;
        }

        emit VoteCast(proposalId, msg.sender, support, weight);
    }

    /// @notice Execute a succeeded proposal after its delay has elapsed.
    /// @dev Permissionless. Execution is a raw `call` into a construction-fixed target.
    function execute(uint256 proposalId) external {
        Proposal storage p = _requireProposal(proposalId);
        if (p.executed) revert ProposalAlreadyExecuted(proposalId);
        if (block.timestamp <= p.voteEnd) revert VotingOpen(p.voteEnd);
        if (state(proposalId) != ProposalState.Succeeded) revert ProposalNotSucceeded(proposalId);

        uint256 executeAfter = p.voteEnd + executionDelay;
        if (block.timestamp < executeAfter) revert ExecutionDelayNotElapsed(executeAfter);

        p.executed = true;

        // solhint-disable-next-line avoid-low-level-calls
        (bool ok, ) = p.target.call(p.data);
        if (!ok) revert ExecutionFailed(proposalId);

        emit ProposalExecuted(proposalId, msg.sender);
    }

    // ---------------------------------------------------------------- views

    /// @notice Derived proposal state. Never stored, so no transition can be missed.
    function state(uint256 proposalId) public view returns (ProposalState) {
        Proposal storage p = _requireProposal(proposalId);
        if (p.executed) return ProposalState.Executed;
        if (block.timestamp <= p.voteEnd) return ProposalState.Active;

        uint256 participation = p.forVotes + p.againstVotes + p.abstainVotes;
        if (participation < p.quorumVotes) return ProposalState.Defeated;
        if (p.forVotes <= p.againstVotes) return ProposalState.Defeated;
        return ProposalState.Succeeded;
    }

    /// @notice Timestamp a succeeded proposal becomes executable.
    function executableAt(uint256 proposalId) external view returns (uint256) {
        return _requireProposal(proposalId).voteEnd + executionDelay;
    }

    /// @notice Current tallies and the quorum they are measured against.
    function tallies(uint256 proposalId)
        external
        view
        returns (uint256 forVotes, uint256 againstVotes, uint256 abstainVotes, uint256 quorumVotes)
    {
        Proposal storage p = _requireProposal(proposalId);
        return (p.forVotes, p.againstVotes, p.abstainVotes, p.quorumVotes);
    }

    /// @notice Calldata a proposal will execute. Separate accessor because the public
    ///         struct getter omits dynamic bytes.
    function proposalData(uint256 proposalId) external view returns (bytes memory) {
        return _requireProposal(proposalId).data;
    }

    // ---------------------------------------------------------------- self-governance

    /// @notice Set the voting duration. Governance only, floor-bounded.
    function setVotingPeriod(uint256 newPeriod) external {
        _requireSelf();
        if (newPeriod < MIN_VOTING_PERIOD) revert BelowFloor(newPeriod, MIN_VOTING_PERIOD);
        emit ParameterUpdated("votingPeriod", votingPeriod, newPeriod);
        votingPeriod = newPeriod;
    }

    /// @notice Set the execution delay. Governance only, floor-bounded.
    function setExecutionDelay(uint256 newDelay) external {
        _requireSelf();
        if (newDelay < MIN_EXECUTION_DELAY) revert BelowFloor(newDelay, MIN_EXECUTION_DELAY);
        emit ParameterUpdated("executionDelay", executionDelay, newDelay);
        executionDelay = newDelay;
    }

    /// @notice Set quorum in basis points of staked supply. Governance only, floor-bounded.
    function setQuorumBps(uint256 newQuorumBps) external {
        _requireSelf();
        if (newQuorumBps < MIN_QUORUM_BPS) revert BelowFloor(newQuorumBps, MIN_QUORUM_BPS);
        emit ParameterUpdated("quorumBps", quorumBps, newQuorumBps);
        quorumBps = newQuorumBps;
    }

    /// @notice Set the minimum stake required to propose. Governance only.
    /// @dev No floor: a zero threshold is a legitimate choice for an open protocol, and
    ///      proposal spam is already bounded by the quorum requirement.
    function setProposalThreshold(uint256 newThreshold) external {
        _requireSelf();
        emit ParameterUpdated("proposalThreshold", proposalThreshold, newThreshold);
        proposalThreshold = newThreshold;
    }

    // ---------------------------------------------------------------- internal

    /// @dev Self-governance setters are reachable only through `execute`, which means only
    ///      through a passed proposal. Admin cannot call them.
    function _requireSelf() internal view {
        if (msg.sender != address(this)) revert NotGovernor(msg.sender);
    }

    function _requireProposal(uint256 proposalId) internal view returns (Proposal storage p) {
        p = proposals[proposalId];
        if (p.snapshotTime == 0) revert NoProposal(proposalId);
    }
}
