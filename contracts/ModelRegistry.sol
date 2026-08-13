// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice Minimal view of StakingVault. Declared locally so ModelRegistry compiles and
///         tests against a mock without importing the full vault.
interface IStakingBond {
    function isBondedProvider(address account) external view returns (bool);
}

/// @title  ModelRegistry
/// @author Thaneesh Shanand Lingan Anandakumar
/// @notice Canonical registry of AI models listed on the marketplace.
/// @dev    Design positions defended in the technical report:
///
///         1. LISTING REQUIRES A BOND. Registration calls
///            StakingVault.isBondedProvider(). Capital at risk, slashable by
///            PerformanceOracle, is what makes a provider's quality claims credible.
///
///         2. RISK TIER IS SELF-DECLARED BY THE PROVIDER. Not assigned by a central
///            authority. This mirrors the EU AI Act, under which providers self-assess
///            and declare conformity, and it keeps this contract's dependency on
///            ComplianceRegistry at zero, avoiding a circular deployment.
///
///         3. NO ON-CHAIN VERSION HISTORY. `metadataCID` is mutable and every change
///            emits ModelUpdated with both old and new values. Full history is
///            reconstructable from events. Storing an append-only array on-chain would
///            grow unboundedly and make any read that touches it a gas liability.
///
///         4. NO PAUSE. The registry custodies no funds. Pausing it would strand
///            providers without protecting anything.
///
///         5. SUSPENSION IS REVERSIBLE, RETIREMENT IS THE PROVIDER'S ALONE. A curator can
///            suspend and unsuspend. Only the provider can retire a model, and retirement
///            is permanent. No role can permanently destroy a provider's listing, which
///            bounds the centralisation the curator represents. Governance can override a
///            curator's suspension but cannot itself terminate a listing.
contract ModelRegistry is AccessControl {
    /// @notice Suspends and unsuspends listings for policy violations.
    bytes32 public constant CURATOR_ROLE = keccak256("CURATOR_ROLE");

    /// @notice Overrides curator suspensions and sets the bond source.
    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");

    /// @notice EU AI Act risk classification, self-declared at registration.
    /// @dev Unacceptable is rejected outright. HighRisk is permitted but flagged, since
    ///      the Act imposes conformity obligations rather than a prohibition.
    enum RiskTier {
        Minimal,
        Limited,
        HighRisk,
        Unacceptable
    }

    /// @notice Listing lifecycle. Three states by design; see contract-level notes.
    enum Status {
        Active,
        Suspended,
        Retired
    }

    /// @param provider    Address that registered the model. Immutable thereafter.
    /// @param metadataCID Hash of the off-chain metadata pointer, typically an IPFS CID.
    /// @param riskTier    Provider's self-declared EU AI Act classification.
    /// @param status      Current lifecycle state.
    /// @param registeredAt Timestamp of registration.
    struct Model {
        address provider;
        bytes32 metadataCID;
        RiskTier riskTier;
        Status status;
        uint256 registeredAt;
    }

    /// @notice Source of provider bond checks.
    IStakingBond public stakingVault;

    /// @notice Monotonic model id counter. First model is id 1; zero means absent.
    uint256 public modelCount;

    /// @notice All registered models by id.
    mapping(uint256 modelId => Model model) public models;

    /// @notice Count of models registered per provider. For monitoring and UI.
    mapping(address provider => uint256 count) public providerModelCount;

    event ModelRegistered(
        uint256 indexed modelId,
        address indexed provider,
        bytes32 metadataCID,
        RiskTier riskTier
    );
    event ModelUpdated(uint256 indexed modelId, bytes32 previousCID, bytes32 newCID);
    event ModelSuspended(uint256 indexed modelId, address indexed by);
    event ModelUnsuspended(uint256 indexed modelId, address indexed by);
    event ModelRetired(uint256 indexed modelId);
    event StakingVaultUpdated(address indexed previous, address indexed current);

    error ZeroAddress();
    error EmptyCID();
    error UnacceptableRiskTier();
    error ProviderNotBonded(address provider);
    error ModelNotFound(uint256 modelId);
    error NotModelProvider(uint256 modelId, address caller);
    error ModelNotActive(uint256 modelId);
    error ModelNotSuspended(uint256 modelId);
    error ModelRetiredPermanently(uint256 modelId);

    /// @param admin        Receives DEFAULT_ADMIN_ROLE, CURATOR_ROLE and GOVERNOR_ROLE.
    /// @param stakingVault_ Address of StakingVault, the bond source.
    constructor(address admin, address stakingVault_) {
        if (admin == address(0)) revert ZeroAddress();
        if (stakingVault_ == address(0)) revert ZeroAddress();

        stakingVault = IStakingBond(stakingVault_);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CURATOR_ROLE, admin);
        _grantRole(GOVERNOR_ROLE, admin);
    }

    // ---------------------------------------------------------------- registration

    /// @notice Register a model. Caller must hold a sufficient bond in StakingVault.
    /// @param metadataCID Hash of the off-chain metadata pointer. Must be non-zero.
    /// @param riskTier    Self-declared EU AI Act tier. Unacceptable is rejected.
    /// @return modelId    The new model's identifier.
    function registerModel(bytes32 metadataCID, RiskTier riskTier) external returns (uint256 modelId) {
        if (metadataCID == bytes32(0)) revert EmptyCID();
        if (riskTier == RiskTier.Unacceptable) revert UnacceptableRiskTier();
        if (!stakingVault.isBondedProvider(msg.sender)) revert ProviderNotBonded(msg.sender);

        modelId = ++modelCount;
        models[modelId] = Model({
            provider: msg.sender,
            metadataCID: metadataCID,
            riskTier: riskTier,
            status: Status.Active,
            registeredAt: block.timestamp
        });
        providerModelCount[msg.sender] += 1;

        emit ModelRegistered(modelId, msg.sender, metadataCID, riskTier);
    }

    /// @notice Update a model's metadata pointer.
    /// @dev Emits both old and new CID so off-chain indexers can rebuild full history.
    ///      Permitted only while Active: a suspended model must be reinstated first, and a
    ///      retired one is immutable.
    function updateMetadata(uint256 modelId, bytes32 newCID) external {
        Model storage m = _requireModel(modelId);
        if (m.provider != msg.sender) revert NotModelProvider(modelId, msg.sender);
        if (newCID == bytes32(0)) revert EmptyCID();
        if (m.status != Status.Active) revert ModelNotActive(modelId);

        bytes32 previous = m.metadataCID;
        m.metadataCID = newCID;
        emit ModelUpdated(modelId, previous, newCID);
    }

    // ---------------------------------------------------------------- lifecycle

    /// @notice Suspend an active listing. Reversible.
    function suspendModel(uint256 modelId) external onlyRole(CURATOR_ROLE) {
        Model storage m = _requireModel(modelId);
        if (m.status != Status.Active) revert ModelNotActive(modelId);

        m.status = Status.Suspended;
        emit ModelSuspended(modelId, msg.sender);
    }

    /// @notice Reinstate a suspended listing.
    /// @dev Open to CURATOR_ROLE and GOVERNOR_ROLE. Governance override is what prevents a
    ///      curator from suspending a listing indefinitely with no recourse.
    function unsuspendModel(uint256 modelId) external {
        if (!hasRole(CURATOR_ROLE, msg.sender) && !hasRole(GOVERNOR_ROLE, msg.sender)) {
            revert AccessControlUnauthorizedAccount(msg.sender, CURATOR_ROLE);
        }
        Model storage m = _requireModel(modelId);
        if (m.status != Status.Suspended) revert ModelNotSuspended(modelId);

        m.status = Status.Active;
        emit ModelUnsuspended(modelId, msg.sender);
    }

    /// @notice Permanently retire a listing. Provider only, irreversible.
    function retireModel(uint256 modelId) external {
        Model storage m = _requireModel(modelId);
        if (m.provider != msg.sender) revert NotModelProvider(modelId, msg.sender);
        if (m.status == Status.Retired) revert ModelRetiredPermanently(modelId);

        m.status = Status.Retired;
        emit ModelRetired(modelId);
    }

    // ---------------------------------------------------------------- views

    /// @notice Whether a model can currently be licensed.
    /// @dev The single function Marketplace calls. Requires an active status AND a provider
    ///      whose bond is still sufficient, so a provider slashed below the threshold
    ///      loses sellability without any listing state needing to change.
    function isListable(uint256 modelId) external view returns (bool) {
        Model storage m = models[modelId];
        if (m.registeredAt == 0) return false;
        if (m.status != Status.Active) return false;
        return stakingVault.isBondedProvider(m.provider);
    }

    /// @notice Full model record.
    function getModel(uint256 modelId) external view returns (Model memory) {
        return _requireModel(modelId);
    }

    /// @notice Whether a model requires enhanced compliance handling.
    /// @dev Consumed by Marketplace to require an enterprise attestation on high-risk
    ///      models while leaving minimal-risk models open.
    function isHighRisk(uint256 modelId) external view returns (bool) {
        return _requireModel(modelId).riskTier == RiskTier.HighRisk;
    }

    // ---------------------------------------------------------------- admin

    /// @notice Repoint the bond source.
    /// @dev Governance-gated. Necessary because StakingVault could be redeployed, but it is
    ///      a real centralisation vector: a malicious vault could report every provider as
    ///      bonded. Documented as an accepted risk mitigated by GOVERNOR_ROLE being held by
    ///      a timelock in production.
    function setStakingVault(address newVault) external onlyRole(GOVERNOR_ROLE) {
        if (newVault == address(0)) revert ZeroAddress();
        emit StakingVaultUpdated(address(stakingVault), newVault);
        stakingVault = IStakingBond(newVault);
    }

    // ---------------------------------------------------------------- internal

    /// @dev Reverts when the model does not exist. `registeredAt` is the existence flag
    ///      because it can never legitimately be zero for a registered model.
    function _requireModel(uint256 modelId) internal view returns (Model storage m) {
        m = models[modelId];
        if (m.registeredAt == 0) revert ModelNotFound(modelId);
    }
}
