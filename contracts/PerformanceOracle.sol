// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice Minimal view of StakingVault used for bond enforcement.
interface IStakingSlasher {
    function slash(address account, uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
}

/// @notice Minimal view of ModelRegistry used to resolve a model's provider.
interface IModelProvider {
    function getModelProvider(uint256 modelId) external view returns (address);
}

/// @title  PerformanceOracle
/// @author Thaneesh Shanand Lingan Anandakumar
/// @notice Aggregates off-chain AI benchmark scores and enforces quality guarantees by
///         slashing the bonds of underperforming model providers.
/// @dev    Design positions defended in the technical report:
///
///         1. PERMISSIONED REPORTER SET, MEAN WITH A DEVIATION GUARD. Not a median. Median
///            aggregation defends against outliers in an open, permissionless reporter
///            network. This reporter set is fixed, capped at MAX_REPORTERS and admitted by
///            governance, so outlier resistance is already provided by permissioning.
///            Sorting on-chain to compute a median would add unbounded gas cost and a
///            large branch surface to defend against a threat the access model already
///            handles. Instead each submission must fall within `maxDeviationBps` of the
///            round's running mean, which catches the failures that actually occur with a
///            permissioned set: fat-finger entries and single-reporter drift.
///
///            Honest limitation: if a majority of the reporter set colludes, neither mean
///            nor median helps. This is recorded as accepted risk.
///
///         2. SCORES EXPIRE. A round older than `stalenessPeriod` cannot trigger
///            enforcement. Stale data driving irreversible economic consequences is the
///            classic oracle failure, so freshness is a precondition rather than a check.
///
///         3. SLASHING IS GATED BY A CHALLENGE WINDOW. A failing round flags the model and
///            opens a window. Only after it lapses unchallenged can the slash execute.
///            Benchmarks are noisy and reporters can be wrong, so instant irreversible
///            punishment on a single round is not defensible. The provider may cancel a
///            pending slash by calling `challenge`, which voids the round and requires a
///            fresh one. There is deliberately no on-chain arbitration: evidence handling
///            belongs off-chain, and a contract that judges benchmark disputes is beyond
///            what this system should attempt.
///
///         4. REPORTERS HAVE NOTHING AT STAKE. They submit scores that destroy other
///            parties' capital while bearing no economic risk themselves. This is a real
///            gap, mitigated only by governance-controlled admission. Reporter bonding is
///            a documented roadmap item, not implemented here.
contract PerformanceOracle is AccessControl {
    /// @notice Submits benchmark scores. Governance-admitted, capped at MAX_REPORTERS.
    bytes32 public constant REPORTER_ROLE = keccak256("REPORTER_ROLE");

    /// @notice Tunes thresholds, windows and the reporter set.
    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");

    /// @notice Hard cap on the reporter set. Bounds gas and keeps quorum meaningful.
    uint256 public constant MAX_REPORTERS = 7;

    /// @notice Scores are expressed in basis points, so 10000 is a perfect score.
    uint256 public constant SCORE_SCALE = 10_000;

    /// @notice Upper bound on the challenge window, so governance cannot stall
    ///         enforcement indefinitely.
    uint256 public constant MAX_CHALLENGE_WINDOW = 30 days;

    /// @notice Upper bound on the staleness period.
    uint256 public constant MAX_STALENESS_PERIOD = 30 days;

    /// @param sum          Running total of submitted scores.
    /// @param count        Number of submissions received.
    /// @param openedAt     Timestamp of the first submission.
    /// @param finalizedAt  Timestamp the round was finalized. Zero while open.
    /// @param meanScore    Final aggregate. Zero while open.
    /// @param flaggedAt    Timestamp enforcement was opened. Zero if the round passed.
    /// @param challenged   True if the provider voided this round.
    /// @param enforced     True once a slash executed. Prevents double enforcement.
    struct Round {
        uint256 sum;
        uint256 count;
        uint256 openedAt;
        uint256 finalizedAt;
        uint256 meanScore;
        uint256 flaggedAt;
        bool challenged;
        bool enforced;
    }

    /// @notice Source of provider bonds.
    IStakingSlasher public immutable STAKING_VAULT;

    /// @notice Source of model ownership.
    IModelProvider public immutable MODEL_REGISTRY;

    /// @notice Current reporter count. Enforced against MAX_REPORTERS.
    uint256 public reporterCount;

    /// @notice Submissions required before a round can be finalized.
    uint256 public quorum;

    /// @notice Mean score at or below which a model is flagged for enforcement.
    uint256 public failureThreshold;

    /// @notice Maximum permitted deviation of a submission from the running mean, in bps.
    uint256 public maxDeviationBps;

    /// @notice Seconds a flagged model has to challenge before a slash may execute.
    uint256 public challengeWindow;

    /// @notice Seconds after finalization that a round remains usable for enforcement.
    uint256 public stalenessPeriod;

    /// @notice Fraction of a provider's bond slashed on enforcement, in bps.
    uint256 public slashBps;

    /// @notice Monotonic round counter per model. First round is 1.
    mapping(uint256 modelId => uint256 latestRound) public latestRound;

    /// @notice Round data by model and round number.
    mapping(uint256 modelId => mapping(uint256 round => Round data)) public rounds;

    /// @notice Whether a reporter has already submitted to a given round.
    mapping(uint256 modelId => mapping(uint256 round => mapping(address reporter => bool)))
        public hasSubmitted;

    event ScoreSubmitted(uint256 indexed modelId, uint256 indexed round, address indexed reporter, uint256 score);
    event RoundFinalized(uint256 indexed modelId, uint256 indexed round, uint256 meanScore, bool flagged);
    event RoundChallenged(uint256 indexed modelId, uint256 indexed round, address indexed provider);
    event SlashEnforced(uint256 indexed modelId, uint256 indexed round, address indexed provider, uint256 amount);
    event ReporterAdded(address indexed reporter);
    event ReporterRemoved(address indexed reporter);
    event ParameterUpdated(string name, uint256 previous, uint256 current);

    error ZeroAddress();
    error ReporterSetFull(uint256 maximum);
    error AlreadyReporter(address reporter);
    error NotAReporter(address reporter);
    error InvalidScore(uint256 score, uint256 maximum);
    error AlreadySubmitted(uint256 modelId, uint256 round);
    error RoundAlreadyFinalized(uint256 modelId, uint256 round);
    error QuorumNotReached(uint256 have, uint256 need);
    error DeviationTooLarge(uint256 score, uint256 mean, uint256 maxBps);
    error NoRound(uint256 modelId);
    error RoundNotFinalized(uint256 modelId, uint256 round);
    error RoundNotFlagged(uint256 modelId, uint256 round);
    error RoundWasChallenged(uint256 modelId, uint256 round);
    error AlreadyEnforced(uint256 modelId, uint256 round);
    error ChallengeWindowOpen(uint256 closesAt);
    error ChallengeWindowClosed(uint256 closedAt);
    error RoundStale(uint256 finalizedAt, uint256 stalenessPeriod);
    error NotModelProvider(uint256 modelId, address caller);
    error NoBondToSlash(address provider);
    error InvalidQuorum(uint256 requested, uint256 reporters);
    error ValueTooLarge(uint256 requested, uint256 maximum);
    error ZeroValue();

    /// @param admin           Receives DEFAULT_ADMIN_ROLE and GOVERNOR_ROLE.
    /// @param stakingVault    StakingVault address. This contract must hold SLASHER_ROLE there.
    /// @param modelRegistry   ModelRegistry address, for provider resolution.
    /// @param challengeWindow_ Initial challenge window. Deploy scripts pass 60 seconds on
    ///                        testnet so the full enforcement arc is demonstrable live;
    ///                        production is recommended at 7 days.
    constructor(
        address admin,
        address stakingVault,
        address modelRegistry,
        uint256 challengeWindow_
    ) {
        if (admin == address(0)) revert ZeroAddress();
        if (stakingVault == address(0)) revert ZeroAddress();
        if (modelRegistry == address(0)) revert ZeroAddress();
        if (challengeWindow_ == 0) revert ZeroValue();
        if (challengeWindow_ > MAX_CHALLENGE_WINDOW) {
            revert ValueTooLarge(challengeWindow_, MAX_CHALLENGE_WINDOW);
        }

        STAKING_VAULT = IStakingSlasher(stakingVault);
        MODEL_REGISTRY = IModelProvider(modelRegistry);

        quorum = 3;
        failureThreshold = 6000; // 60 percent
        maxDeviationBps = 2500; // 25 percent from the running mean
        challengeWindow = challengeWindow_;
        stalenessPeriod = 7 days;
        slashBps = 1000; // 10 percent of bond

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNOR_ROLE, admin);
    }

    // ---------------------------------------------------------------- reporting

    /// @notice Submit a benchmark score for a model, opening a round if none is active.
    /// @dev Each submission after the first must fall within `maxDeviationBps` of the
    ///      round's running mean. One submission per reporter per round.
    /// @param modelId The model being scored.
    /// @param score   Score in basis points, 0 to SCORE_SCALE inclusive.
    function submitScore(uint256 modelId, uint256 score) external onlyRole(REPORTER_ROLE) {
        if (score > SCORE_SCALE) revert InvalidScore(score, SCORE_SCALE);

        uint256 round = latestRound[modelId];
        // Open a new round when there is none, or when the previous one is closed.
        if (round == 0 || rounds[modelId][round].finalizedAt != 0) {
            round = ++latestRound[modelId];
            rounds[modelId][round].openedAt = block.timestamp;
        }

        Round storage r = rounds[modelId][round];
        if (hasSubmitted[modelId][round][msg.sender]) revert AlreadySubmitted(modelId, round);

        if (r.count > 0) {
            // Deviation guard, restructured to remove all division from the comparison.
            //
            // The natural form is:
            //     runningMean = sum / count
            //     delta       = |score - runningMean|
            //     reject if    delta * SCORE_SCALE > runningMean * maxDeviationBps
            //
            // That divides before multiplying, so the truncated mean feeds a product and
            // Slither flags it (divide-before-multiply). Multiplying both sides by `count`
            // gives an algebraically identical test with no division at all:
            //
            //     scaledDelta = |score * count - sum|          (this is delta * count)
            //     reject if     scaledDelta * SCORE_SCALE > sum * maxDeviationBps
            //
            // Exact rather than merely conservative. Overflow is impossible: score is
            // bounded by SCORE_SCALE (10,000) and count by MAX_REPORTERS (7), so the
            // largest intermediate is 7e8.
            uint256 scaled = score * r.count;
            uint256 scaledDelta = scaled > r.sum ? scaled - r.sum : r.sum - scaled;

            if ((scaledDelta * SCORE_SCALE) > (r.sum * maxDeviationBps)) {
                // The mean is computed only on the revert path, purely for the error
                // message, so no product consumes a truncated value.
                revert DeviationTooLarge(score, r.sum / r.count, maxDeviationBps);
            }
        }

        r.sum += score;
        r.count += 1;
        hasSubmitted[modelId][round][msg.sender] = true;

        emit ScoreSubmitted(modelId, round, msg.sender, score);
    }

    /// @notice Close the active round, compute the mean, and flag the model if it failed.
    /// @dev Permissionless by design. Anyone may finalize once quorum is met; withholding
    ///      finalization must not be a way to shield a failing model.
    function finalizeRound(uint256 modelId) external {
        uint256 round = latestRound[modelId];
        if (round == 0) revert NoRound(modelId);

        Round storage r = rounds[modelId][round];
        if (r.finalizedAt != 0) revert RoundAlreadyFinalized(modelId, round);
        if (r.count < quorum) revert QuorumNotReached(r.count, quorum);

        uint256 mean = r.sum / r.count;
        r.meanScore = mean;
        r.finalizedAt = block.timestamp;

        bool flagged = mean <= failureThreshold;
        if (flagged) {
            r.flaggedAt = block.timestamp;
        }

        emit RoundFinalized(modelId, round, mean, flagged);
    }

    // ---------------------------------------------------------------- enforcement

    /// @notice Void a pending slash. Callable only by the model's provider, only inside
    ///         the challenge window.
    /// @dev No evidence is submitted on-chain and no arbitration occurs. A challenge voids
    ///      the round and forces reporters to run a fresh one. Evidence handling belongs
    ///      off-chain; a contract adjudicating benchmark disputes is outside this system's
    ///      remit. The residual risk, that a provider can repeatedly challenge to delay
    ///      enforcement, is recorded in the audit report.
    function challenge(uint256 modelId) external {
        uint256 round = latestRound[modelId];
        if (round == 0) revert NoRound(modelId);

        Round storage r = rounds[modelId][round];
        if (r.finalizedAt == 0) revert RoundNotFinalized(modelId, round);
        if (r.flaggedAt == 0) revert RoundNotFlagged(modelId, round);
        if (r.challenged) revert RoundWasChallenged(modelId, round);
        if (r.enforced) revert AlreadyEnforced(modelId, round);

        address provider = MODEL_REGISTRY.getModelProvider(modelId);
        if (provider != msg.sender) revert NotModelProvider(modelId, msg.sender);

        uint256 closesAt = r.flaggedAt + challengeWindow;
        if (block.timestamp > closesAt) revert ChallengeWindowClosed(closesAt);

        r.challenged = true;
        emit RoundChallenged(modelId, round, msg.sender);
    }

    /// @notice Execute the slash for a flagged, unchallenged, fresh round.
    /// @dev Permissionless. Requires this contract to hold SLASHER_ROLE on StakingVault.
    ///      The amount is `slashBps` of the provider's current bond; StakingVault applies
    ///      its own 50 percent per-call cap as a second backstop.
    function enforceSlash(uint256 modelId) external {
        uint256 round = latestRound[modelId];
        if (round == 0) revert NoRound(modelId);

        Round storage r = rounds[modelId][round];
        if (r.finalizedAt == 0) revert RoundNotFinalized(modelId, round);
        if (r.flaggedAt == 0) revert RoundNotFlagged(modelId, round);
        if (r.challenged) revert RoundWasChallenged(modelId, round);
        if (r.enforced) revert AlreadyEnforced(modelId, round);

        uint256 closesAt = r.flaggedAt + challengeWindow;
        if (block.timestamp <= closesAt) revert ChallengeWindowOpen(closesAt);

        // Stale data must never drive an irreversible economic consequence.
        if (block.timestamp > r.finalizedAt + stalenessPeriod) {
            revert RoundStale(r.finalizedAt, stalenessPeriod);
        }

        address provider = MODEL_REGISTRY.getModelProvider(modelId);
        uint256 bond = STAKING_VAULT.balanceOf(provider);
        if (bond == 0) revert NoBondToSlash(provider);

        uint256 amount = (bond * slashBps) / SCORE_SCALE;
        if (amount == 0) revert NoBondToSlash(provider);

        r.enforced = true;
        STAKING_VAULT.slash(provider, amount);

        emit SlashEnforced(modelId, round, provider, amount);
    }

    // ---------------------------------------------------------------- views

    /// @notice Latest finalized mean score and its finalization timestamp.
    function latestScore(uint256 modelId) external view returns (uint256 meanScore, uint256 finalizedAt) {
        Round storage r = rounds[modelId][latestRound[modelId]];
        return (r.meanScore, r.finalizedAt);
    }

    /// @notice Whether the latest round is finalized and still within the staleness window.
    /// @dev Consumed by Marketplace and the monitoring dashboard.
    function isScoreFresh(uint256 modelId) external view returns (bool) {
        Round storage r = rounds[modelId][latestRound[modelId]];
        if (r.finalizedAt == 0) return false;
        return block.timestamp <= r.finalizedAt + stalenessPeriod;
    }

    /// @notice Seconds remaining in the current challenge window. Zero if none is open.
    function challengeTimeRemaining(uint256 modelId) external view returns (uint256) {
        Round storage r = rounds[modelId][latestRound[modelId]];
        if (r.flaggedAt == 0 || r.challenged || r.enforced) return 0;
        uint256 closesAt = r.flaggedAt + challengeWindow;
        if (block.timestamp >= closesAt) return 0;
        return closesAt - block.timestamp;
    }

    // ---------------------------------------------------------------- reporter set

    /// @notice Admit a reporter, subject to MAX_REPORTERS.
    function addReporter(address reporter) external onlyRole(GOVERNOR_ROLE) {
        if (reporter == address(0)) revert ZeroAddress();
        if (hasRole(REPORTER_ROLE, reporter)) revert AlreadyReporter(reporter);
        if (reporterCount >= MAX_REPORTERS) revert ReporterSetFull(MAX_REPORTERS);

        reporterCount += 1;
        _grantRole(REPORTER_ROLE, reporter);
        emit ReporterAdded(reporter);
    }

    /// @notice Remove a reporter.
    function removeReporter(address reporter) external onlyRole(GOVERNOR_ROLE) {
        if (!hasRole(REPORTER_ROLE, reporter)) revert NotAReporter(reporter);

        reporterCount -= 1;
        _revokeRole(REPORTER_ROLE, reporter);
        emit ReporterRemoved(reporter);
    }

    // ---------------------------------------------------------------- parameters

    /// @notice Set the submissions required to finalize a round.
    function setQuorum(uint256 newQuorum) external onlyRole(GOVERNOR_ROLE) {
        if (newQuorum == 0) revert ZeroValue();
        if (newQuorum > MAX_REPORTERS) revert InvalidQuorum(newQuorum, MAX_REPORTERS);
        emit ParameterUpdated("quorum", quorum, newQuorum);
        quorum = newQuorum;
    }

    /// @notice Set the mean score at or below which a model is flagged.
    function setFailureThreshold(uint256 newThreshold) external onlyRole(GOVERNOR_ROLE) {
        if (newThreshold > SCORE_SCALE) revert ValueTooLarge(newThreshold, SCORE_SCALE);
        emit ParameterUpdated("failureThreshold", failureThreshold, newThreshold);
        failureThreshold = newThreshold;
    }

    /// @notice Set the permitted deviation from the running mean.
    function setMaxDeviationBps(uint256 newDeviation) external onlyRole(GOVERNOR_ROLE) {
        if (newDeviation == 0) revert ZeroValue();
        if (newDeviation > SCORE_SCALE) revert ValueTooLarge(newDeviation, SCORE_SCALE);
        emit ParameterUpdated("maxDeviationBps", maxDeviationBps, newDeviation);
        maxDeviationBps = newDeviation;
    }

    /// @notice Set the challenge window.
    function setChallengeWindow(uint256 newWindow) external onlyRole(GOVERNOR_ROLE) {
        if (newWindow == 0) revert ZeroValue();
        if (newWindow > MAX_CHALLENGE_WINDOW) revert ValueTooLarge(newWindow, MAX_CHALLENGE_WINDOW);
        emit ParameterUpdated("challengeWindow", challengeWindow, newWindow);
        challengeWindow = newWindow;
    }

    /// @notice Set how long a finalized round remains usable.
    function setStalenessPeriod(uint256 newPeriod) external onlyRole(GOVERNOR_ROLE) {
        if (newPeriod == 0) revert ZeroValue();
        if (newPeriod > MAX_STALENESS_PERIOD) revert ValueTooLarge(newPeriod, MAX_STALENESS_PERIOD);
        emit ParameterUpdated("stalenessPeriod", stalenessPeriod, newPeriod);
        stalenessPeriod = newPeriod;
    }

    /// @notice Set the fraction of bond slashed on enforcement.
    function setSlashBps(uint256 newSlashBps) external onlyRole(GOVERNOR_ROLE) {
        if (newSlashBps == 0) revert ZeroValue();
        if (newSlashBps > SCORE_SCALE) revert ValueTooLarge(newSlashBps, SCORE_SCALE);
        emit ParameterUpdated("slashBps", slashBps, newSlashBps);
        slashBps = newSlashBps;
    }
}
