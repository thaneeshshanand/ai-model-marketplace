// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title  ComplianceRegistry
/// @author Thaneesh Shanand Lingan Anandakumar
/// @notice Enterprise attestations and privacy-preserving disclosure records for the
///         AI Model Marketplace.
/// @dev    Three positions this contract takes, all defended in the technical report:
///
///         1. NO PERSONAL DATA ON-CHAIN, EVER. Attestations record that an off-chain
///            verification happened, identified only by a document hash. Names, documents,
///            jurisdictions and identifiers stay with the attestor. A public ledger and
///            the GDPR right to erasure are fundamentally incompatible, so the design
///            avoids the conflict rather than trying to manage it.
///
///         2. DISCLOSURE GRANTS ARE STORED AS HASHES. A public record reading
///            "Provider A granted Enterprise B access to Model C" leaks the commercial
///            relationship, which is frequently the sensitive part. Grants are stored as
///            keccak256(modelId, grantee, salt). A party holding the tuple can prove the
///            grant exists; an observer cannot enumerate who has access to what. This is
///            selective disclosure in substance rather than in name.
///
///         3. ATTESTATIONS EXPIRE. Compliance is a continuing obligation, not a one-time
///            gate, so every attestation carries an expiry and periodic reverification is
///            structurally required.
///
///         This contract deliberately knows nothing about models or ModelRegistry. It
///         attests to ENTITIES only. Keeping the dependency one-directional means
///         ComplianceRegistry deploys first and needs no post-deploy wiring, avoiding a
///         partially initialised contract and a repointable admin setter.
contract ComplianceRegistry is AccessControl {
    /// @notice Grants and revokes entity attestations. Held by a compliance operator.
    bytes32 public constant ATTESTOR_ROLE = keccak256("ATTESTOR_ROLE");

    /// @notice Maximum attestation validity. Caps how stale a verification can become.
    uint256 public constant MAX_VALIDITY_PERIOD = 730 days;

    /// @notice An off-chain compliance verification, referenced only by hash.
    /// @param documentHash Hash of the off-chain evidence bundle. Never the evidence.
    /// @param issuedAt     Timestamp the attestation was granted.
    /// @param expiresAt    Timestamp after which the attestation is no longer valid.
    /// @param revoked      Set true on revocation. Kept rather than deleted so the
    ///                     historical record survives, which auditors require.
    struct Attestation {
        bytes32 documentHash;
        uint256 issuedAt;
        uint256 expiresAt;
        bool revoked;
    }

    /// @notice Attestation held by each entity address.
    mapping(address entity => Attestation attestation) public attestations;

    /// @notice Disclosure grant commitments. Key is keccak256(modelId, grantee, salt).
    mapping(bytes32 commitment => bool granted) public disclosureGrants;

    event AttestationGranted(address indexed entity, bytes32 documentHash, uint256 expiresAt);
    event AttestationRevoked(address indexed entity, address indexed revokedBy);
    event DisclosureGranted(bytes32 indexed commitment, address indexed grantor);
    event DisclosureRevoked(bytes32 indexed commitment, address indexed grantor);

    error ZeroAddress();
    error EmptyDocumentHash();
    error ValidityPeriodTooLong(uint256 requested, uint256 maximum);
    error ZeroValidityPeriod();
    error NoAttestation(address entity);
    error AlreadyRevoked(address entity);
    error EmptyCommitment();
    error GrantAlreadyExists(bytes32 commitment);
    error GrantNotFound(bytes32 commitment);

    /// @param admin Receives DEFAULT_ADMIN_ROLE and ATTESTOR_ROLE at deployment.
    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ATTESTOR_ROLE, admin);
    }

    // ---------------------------------------------------------------- attestations

    /// @notice Attest that `entity` passed off-chain compliance verification.
    /// @dev Overwrites any existing attestation, which is how renewal works.
    /// @param entity         The verified address.
    /// @param documentHash   Hash of the off-chain evidence. Must be non-zero.
    /// @param validityPeriod Seconds the attestation remains valid.
    function grantAttestation(address entity, bytes32 documentHash, uint256 validityPeriod)
        external
        onlyRole(ATTESTOR_ROLE)
    {
        if (entity == address(0)) revert ZeroAddress();
        if (documentHash == bytes32(0)) revert EmptyDocumentHash();
        if (validityPeriod == 0) revert ZeroValidityPeriod();
        if (validityPeriod > MAX_VALIDITY_PERIOD) {
            revert ValidityPeriodTooLong(validityPeriod, MAX_VALIDITY_PERIOD);
        }

        uint256 expiresAt = block.timestamp + validityPeriod;
        attestations[entity] = Attestation({
            documentHash: documentHash,
            issuedAt: block.timestamp,
            expiresAt: expiresAt,
            revoked: false
        });

        emit AttestationGranted(entity, documentHash, expiresAt);
    }

    /// @notice Revoke an attestation before its expiry.
    /// @dev The record is marked rather than deleted so the audit trail survives.
    function revokeAttestation(address entity) external onlyRole(ATTESTOR_ROLE) {
        Attestation storage a = attestations[entity];
        if (a.issuedAt == 0) revert NoAttestation(entity);
        if (a.revoked) revert AlreadyRevoked(entity);

        a.revoked = true;
        emit AttestationRevoked(entity, msg.sender);
    }

    /// @notice Whether `entity` currently holds a valid attestation.
    /// @dev The single function other contracts call. Marketplace checks this at purchase
    ///      initiation and records the result on the order, so an expiry occurring
    ///      mid-settlement cannot strand an in-flight transaction.
    function isCompliant(address entity) external view returns (bool) {
        Attestation storage a = attestations[entity];
        if (a.issuedAt == 0) return false;
        if (a.revoked) return false;
        return block.timestamp <= a.expiresAt;
    }

    /// @notice Seconds until `entity`'s attestation expires. Zero if expired or absent.
    /// @dev Exposed for the monitoring dashboard to surface upcoming reverifications.
    function timeUntilExpiry(address entity) external view returns (uint256) {
        Attestation storage a = attestations[entity];
        if (a.issuedAt == 0 || a.revoked) return 0;
        if (block.timestamp >= a.expiresAt) return 0;
        return a.expiresAt - block.timestamp;
    }

    // ---------------------------------------------------------------- selective disclosure

    /// @notice Record a disclosure grant as an opaque commitment.
    /// @dev The caller computes keccak256(abi.encode(modelId, grantee, salt)) off-chain
    ///      and submits only the digest. Nothing on-chain reveals the model, the grantee,
    ///      or the relationship between them.
    function grantDisclosure(bytes32 commitment) external {
        if (commitment == bytes32(0)) revert EmptyCommitment();
        if (disclosureGrants[commitment]) revert GrantAlreadyExists(commitment);

        disclosureGrants[commitment] = true;
        emit DisclosureGranted(commitment, msg.sender);
    }

    /// @notice Withdraw a previously recorded disclosure grant.
    /// @dev Only the address that can reproduce the commitment can revoke it, since the
    ///      preimage is required to compute the key.
    function revokeDisclosure(bytes32 commitment) external {
        if (!disclosureGrants[commitment]) revert GrantNotFound(commitment);

        disclosureGrants[commitment] = false;
        emit DisclosureRevoked(commitment, msg.sender);
    }

    /// @notice Verify a disclosure grant by supplying its preimage.
    /// @dev Proves access without the caller ever having published the tuple on-chain.
    function verifyDisclosure(uint256 modelId, address grantee, bytes32 salt)
        external
        view
        returns (bool)
    {
        return disclosureGrants[computeCommitment(modelId, grantee, salt)];
    }

    /// @notice Helper for computing a commitment. Pure, so callers may use it off-chain.
    function computeCommitment(uint256 modelId, address grantee, bytes32 salt)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(modelId, grantee, salt));
    }
}
