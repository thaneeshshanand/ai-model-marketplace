// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title  RegistryReceiver
/// @author Thaneesh Shanand Lingan Anandakumar
/// @notice Destination-chain half of the AIMM cross-chain registry sync. Deployed on
///         Polygon Amoy.
/// @dev    Accepts attestations forwarded by an authorised relayer and maintains a mirror
///         of the Sepolia ModelRegistry.
///
///         THIS CONTRACT IS DELIBERATELY POWERLESS. It writes only its own mirror mapping.
///         It holds no role on any other contract, custodies no funds, and cannot call
///         out. That is the entire security argument: a compromised relayer can publish
///         false mirror entries here and nothing else anywhere.
///
///         REPLAY PROTECTION IS A CONSUMED-NONCE MAPPING, NOT A SEQUENCE COUNTER. An
///         earlier design required strictly increasing nonces. That was rejected because a
///         single failed message would block every later one permanently, a liveness
///         failure with no upside: a registry mirror has no ordering requirement. Messages
///         may therefore arrive out of order, and each nonce is consumable exactly once.
///
///         STALE-WRITE GUARD. Because delivery is unordered, an older attestation could
///         arrive after a newer one and overwrite fresher state. `sourceTimestamp` is
///         compared and older payloads are rejected, so the mirror only ever moves
///         forward per model.
contract RegistryReceiver is AccessControl {
    /// @notice May deliver attestations. Held by the relayer account.
    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");

    /// @param provider        Provider address as reported by the source chain.
    /// @param listable        Whether the model was listable when attested.
    /// @param highRisk        Whether the model self-declared the high-risk tier.
    /// @param sourceTimestamp Source-chain timestamp of the attestation.
    /// @param receivedAt      Destination-chain timestamp of delivery.
    /// @param nonce           Source-chain message nonce that produced this entry.
    struct MirroredModel {
        address provider;
        bool listable;
        bool highRisk;
        uint256 sourceTimestamp;
        uint256 receivedAt;
        uint256 nonce;
    }

    /// @notice Mirror of the source-chain registry.
    mapping(uint256 modelId => MirroredModel model) public mirroredModels;

    /// @notice Nonces already delivered. Consumable exactly once, in any order.
    mapping(uint256 nonce => bool used) public consumed;

    /// @notice Count of distinct models mirrored. For monitoring sync completeness.
    uint256 public mirroredCount;

    /// @notice Highest nonce delivered so far. Compared against the gateway's `nonce` to
    ///         measure sync lag.
    uint256 public highestNonce;

    event AttestationReceived(
        uint256 indexed nonce,
        uint256 indexed modelId,
        address indexed provider,
        bool listable,
        bool highRisk,
        uint256 sourceTimestamp
    );

    error ZeroAddress();
    error ZeroNonce();
    error NonceAlreadyConsumed(uint256 nonce);
    error ZeroProvider();
    error StaleAttestation(uint256 sourceTimestamp, uint256 mirroredTimestamp);
    error ModelNotMirrored(uint256 modelId);

    /// @param admin   Receives DEFAULT_ADMIN_ROLE.
    /// @param relayer Receives RELAYER_ROLE. May be the same address as admin on testnet.
    constructor(address admin, address relayer) {
        if (admin == address(0)) revert ZeroAddress();
        if (relayer == address(0)) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RELAYER_ROLE, relayer);
    }

    /// @notice Deliver an attestation observed on the source chain.
    /// @dev Parameters mirror the gateway's `ModelAttested` event exactly, so a relayer can
    ///      copy them across without transformation. This is also what makes a manual relay
    ///      through a block explorer practical.
    function receiveAttestation(
        uint256 messageNonce,
        uint256 modelId,
        address provider,
        bool listable,
        bool highRisk,
        uint256 sourceTimestamp
    ) external onlyRole(RELAYER_ROLE) {
        if (messageNonce == 0) revert ZeroNonce();
        if (consumed[messageNonce]) revert NonceAlreadyConsumed(messageNonce);
        if (provider == address(0)) revert ZeroProvider();

        MirroredModel storage existing = mirroredModels[modelId];
        // Unordered delivery means an older payload could arrive late. Reject it rather
        // than let the mirror move backwards.
        if (existing.sourceTimestamp > sourceTimestamp) {
            revert StaleAttestation(sourceTimestamp, existing.sourceTimestamp);
        }

        consumed[messageNonce] = true;
        if (messageNonce > highestNonce) {
            highestNonce = messageNonce;
        }
        if (existing.sourceTimestamp == 0) {
            mirroredCount += 1;
        }

        mirroredModels[modelId] = MirroredModel({
            provider: provider,
            listable: listable,
            highRisk: highRisk,
            sourceTimestamp: sourceTimestamp,
            receivedAt: block.timestamp,
            nonce: messageNonce
        });

        emit AttestationReceived(messageNonce, modelId, provider, listable, highRisk, sourceTimestamp);
    }

    /// @notice Whether a model is listable according to the mirror.
    /// @dev A destination-chain marketplace would consume this. None is deployed in this
    ///      submission: mirrored data is advisory, and adding an Amoy-side marketplace
    ///      would require duplicating the token, compliance registry and listing set on a
    ///      second chain for no additional demonstrated capability.
    function isMirroredListable(uint256 modelId) external view returns (bool) {
        MirroredModel storage m = mirroredModels[modelId];
        if (m.sourceTimestamp == 0) return false;
        return m.listable;
    }

    /// @notice Full mirrored record.
    function getMirroredModel(uint256 modelId) external view returns (MirroredModel memory) {
        MirroredModel storage m = mirroredModels[modelId];
        if (m.sourceTimestamp == 0) revert ModelNotMirrored(modelId);
        return m;
    }

    /// @notice Seconds between source attestation and destination delivery for a model.
    /// @dev Exposed as the primary cross-chain monitoring signal.
    ///
    ///      Returns zero when the destination timestamp is not later than the source.
    ///      Independent chains do not share a clock, and Amoy block timestamps can drift
    ///      behind Sepolia's, so subtracting without this guard would underflow and revert
    ///      a view function that monitoring depends on.
    function syncLatency(uint256 modelId) external view returns (uint256) {
        MirroredModel storage m = mirroredModels[modelId];
        if (m.sourceTimestamp == 0) revert ModelNotMirrored(modelId);
        if (m.receivedAt <= m.sourceTimestamp) return 0;
        return m.receivedAt - m.sourceTimestamp;
    }
}
