// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice Minimal view of ModelRegistry needed to attest a listing.
interface IRegistrySource {
    function getModelProvider(uint256 modelId) external view returns (address);
    function isListable(uint256 modelId) external view returns (bool);
    function isHighRisk(uint256 modelId) external view returns (bool);
}

/// @title  RegistryGateway
/// @author Thaneesh Shanand Lingan Anandakumar
/// @notice Source-chain half of the AIMM cross-chain registry sync. Deployed on Ethereum
///         Sepolia alongside the canonical ModelRegistry.
/// @dev    Emits an attestation event per model. An off-chain relayer observes the event
///         and submits the same payload to RegistryReceiver on Polygon Amoy.
///
///         WHAT THIS IS NOT. This is not a trustless bridge. There is no light client, no
///         proof verification, and no multi-signature threshold. It is a permissioned
///         relay, and the security argument rests on bounding the consequences rather than
///         eliminating the trust:
///
///           - The relayer can only write mirror state on the destination chain. It holds
///             no role on any other AIMM contract on either chain.
///           - A compromised relayer can therefore publish false mirror entries on Amoy.
///             It cannot mint, slash, vote, move escrow, or alter any Sepolia state.
///           - Mirrored data is advisory on the destination chain. Nothing authoritative
///             depends on it. This is the Poly Network lesson stated as a design
///             constraint: that bridge failed because the relay path could reach
///             privileged functions. Here it cannot reach any.
///
///         NO SIGNED DIGEST. An earlier design bound chain id, receiver address and
///         payload into a keccak256 digest. It was removed because nothing verifies a
///         signature over it, so the hash was decorative. A signature from an authorised
///         relayer key and a transaction from an authorised relayer account are the same
///         trust assumption; the signature version only adds a verification path. Replay
///         protection lives entirely in the receiver's `consumed` mapping.
contract RegistryGateway is AccessControl {
    /// @notice May emit attestations. Held by an operations account or a keeper.
    bytes32 public constant ATTESTOR_ROLE = keccak256("ATTESTOR_ROLE");

    /// @notice Canonical registry on this chain.
    IRegistrySource public immutable MODEL_REGISTRY;

    /// @notice Monotonic message counter. First attestation is nonce 1.
    uint256 public nonce;

    /// @notice Nonce of the most recent attestation per model, or zero if never attested.
    mapping(uint256 modelId => uint256 lastNonce) public lastAttestedNonce;

    /// @notice Emitted for the relayer to observe and forward.
    /// @param nonce      Unique, strictly increasing message identifier.
    /// @param modelId    Model being attested.
    /// @param provider   Provider address on the source chain.
    /// @param listable   Whether the model was listable at attestation time.
    /// @param highRisk   Whether the model self-declared the EU AI Act high-risk tier.
    /// @param attestedAt Source-chain timestamp.
    event ModelAttested(
        uint256 indexed nonce,
        uint256 indexed modelId,
        address indexed provider,
        bool listable,
        bool highRisk,
        uint256 attestedAt
    );

    error ZeroAddress();
    error ModelHasNoProvider(uint256 modelId);

    /// @param admin          Receives DEFAULT_ADMIN_ROLE and ATTESTOR_ROLE.
    /// @param modelRegistry  Canonical ModelRegistry on this chain.
    constructor(address admin, address modelRegistry) {
        if (admin == address(0)) revert ZeroAddress();
        if (modelRegistry == address(0)) revert ZeroAddress();

        MODEL_REGISTRY = IRegistrySource(modelRegistry);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ATTESTOR_ROLE, admin);
    }

    /// @notice Emit a cross-chain attestation for a model's current registry state.
    /// @dev Re-attesting the same model is permitted and expected: it is how a status
    ///      change, such as suspension or a bond falling below threshold, propagates to
    ///      the destination chain. Each call consumes a fresh nonce.
    /// @return messageNonce The nonce assigned to this attestation.
    function attestModel(uint256 modelId)
        external
        onlyRole(ATTESTOR_ROLE)
        returns (uint256 messageNonce)
    {
        address provider = MODEL_REGISTRY.getModelProvider(modelId);
        if (provider == address(0)) revert ModelHasNoProvider(modelId);

        bool listable = MODEL_REGISTRY.isListable(modelId);
        bool highRisk = MODEL_REGISTRY.isHighRisk(modelId);

        messageNonce = ++nonce;
        lastAttestedNonce[modelId] = messageNonce;

        emit ModelAttested(messageNonce, modelId, provider, listable, highRisk, block.timestamp);
    }

    /// @notice Whether a model has ever been attested across chains.
    function hasBeenAttested(uint256 modelId) external view returns (bool) {
        return lastAttestedNonce[modelId] != 0;
    }
}
