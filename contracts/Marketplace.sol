// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @notice Minimal view of ModelRegistry.
interface IModelRegistryView {
    function isListable(uint256 modelId) external view returns (bool);
    function getModelProvider(uint256 modelId) external view returns (address);
    function isHighRisk(uint256 modelId) external view returns (bool);
}

/// @notice Minimal view of ComplianceRegistry.
interface IComplianceView {
    function isCompliant(address entity) external view returns (bool);
}

/// @title  Marketplace
/// @author Thaneesh Shanand Lingan Anandakumar
/// @notice Fixed-price licensing of registered AI models, with commit-reveal purchase
///         privacy and escrowed settlement.
/// @dev    Design positions defended in the technical report:
///
///         1. FIXED PRICE, NOT AN AUCTION. An AI model licence is a non-rival good: it is
///            infinitely copyable and sold to any number of enterprises at once. There is
///            nothing to bid against, so a sealed-bid auction would be mechanism theatre.
///
///         2. COMMIT-REVEAL PROTECTS THE BUYER, NOT THE PRICE. The privacy problem here is
///            not price discovery, it is that a public `LicensePurchased(modelId, buyer)`
///            event leaks which enterprise is procuring which capability. That is a
///            genuine enterprise objection to public ledgers. A purchase therefore commits
///            keccak256(modelId, buyer, salt) first and reveals only at settlement, when
///            the buyer chooses to.
///
///            Precise privacy claim: an observer of the commit sees an address and an
///            escrow amount, never the model. Buyers may deliberately over-escrow to
///            obscure the price bracket too; the surplus is refunded on reveal.
///
///         3. COMPLIANCE IS EVALUATED AT COMMIT AND RECORDED ON THE ORDER. Because the
///            model is hidden at commit time, the buyer's attestation status is checked
///            unconditionally then and stored as `compliantAtCommit`. At reveal, a
///            high-risk model requires that recorded flag. This honours the interface
///            commitment made to ComplianceRegistry: an attestation expiring mid-flight
///            cannot strand a settlement that was compliant when initiated.
///
///         4. ESCROW IS ACCOUNTED SEPARATELY. `totalEscrowed` tracks buyer funds held. The
///            contract must always hold at least that much, mirroring the
///            totalStaked/rewardReserve separation in StakingVault. See `solvency()`.
///
///         5. PAUSE BLOCKS NEW COMMITS ONLY. Reveal and cancel stay open, so a pause can
///            never trap escrowed funds.
contract Marketplace is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    /// @notice Tunes fees, windows and the treasury.
    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");

    /// @notice Emergency stop on new commitments.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice Basis-point denominator.
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Ceiling on the protocol fee, so governance cannot expropriate providers.
    uint256 public constant MAX_PROTOCOL_FEE_BPS = 2000; // 20 percent

    /// @notice Ceiling on the reveal window.
    uint256 public constant MAX_REVEAL_WINDOW = 30 days;

    /// @param price    Licence price in AIM.
    /// @param active   False once delisted. Existing licences are unaffected.
    /// @param exists   Distinguishes a delisted listing from one never created.
    struct Listing {
        uint256 price;
        bool active;
        bool exists;
    }

    /// @param buyer              Committer. Only this address may reveal.
    /// @param escrow             AIM held against the eventual settlement.
    /// @param committedAt        Timestamp of the commit, for reveal-window expiry.
    /// @param compliantAtCommit  Buyer's attestation status when the order was initiated.
    /// @param settled            True once revealed or cancelled. Prevents replay.
    struct Commitment {
        address buyer;
        uint256 escrow;
        uint256 committedAt;
        bool compliantAtCommit;
        bool settled;
    }

    /// @notice Payment asset.
    IERC20 public immutable PAYMENT_TOKEN;

    /// @notice Model listing source.
    IModelRegistryView public immutable MODEL_REGISTRY;

    /// @notice Enterprise attestation source.
    IComplianceView public immutable COMPLIANCE_REGISTRY;

    /// @notice Receives protocol fees.
    address public treasury;

    /// @notice Protocol fee in basis points.
    uint256 public protocolFeeBps;

    /// @notice Seconds a buyer has to reveal before the commitment may be cancelled.
    uint256 public revealWindow;

    /// @notice Total buyer funds held in escrow. Never includes fees.
    uint256 public totalEscrowed;

    /// @notice Cumulative fees forwarded to the treasury. For reporting only.
    uint256 public lifetimeFees;

    /// @notice One listing per model.
    mapping(uint256 modelId => Listing listing) public listings;

    /// @notice Open and historical commitments, keyed by their digest.
    mapping(bytes32 commitment => Commitment order) public commitments;

    /// @notice Whether an address holds a licence for a model.
    mapping(uint256 modelId => mapping(address buyer => bool licensed)) public hasLicense;

    event ListingCreated(uint256 indexed modelId, address indexed provider, uint256 price);
    event ListingPriceUpdated(uint256 indexed modelId, uint256 previousPrice, uint256 newPrice);
    event ListingDelisted(uint256 indexed modelId);
    event PurchaseCommitted(bytes32 indexed commitment, address indexed buyer, uint256 escrow);
    event PurchaseRevealed(
        uint256 indexed modelId,
        address indexed buyer,
        uint256 price,
        uint256 fee
    );
    event CommitmentCancelled(bytes32 indexed commitment, address indexed buyer, uint256 refund);
    event TreasuryUpdated(address indexed previous, address indexed current);
    event ParameterUpdated(string name, uint256 previous, uint256 current);

    error ZeroAddress();
    error ZeroAmount();
    error ZeroPrice();
    error NotModelProvider(uint256 modelId, address caller);
    error ModelNotListable(uint256 modelId);
    error ListingNotFound(uint256 modelId);
    error ListingInactive(uint256 modelId);
    error ListingAlreadyExists(uint256 modelId);
    error EmptyCommitment();
    error CommitmentExists(bytes32 commitment);
    error CommitmentNotFound(bytes32 commitment);
    error CommitmentSettled(bytes32 commitment);
    error NotCommitmentOwner(bytes32 commitment, address caller);
    error RevealWindowExpired(uint256 expiredAt);
    error RevealWindowOpen(uint256 closesAt);
    error InsufficientEscrow(uint256 escrow, uint256 price);
    error ComplianceRequired(address buyer);
    error AlreadyLicensed(uint256 modelId, address buyer);
    error ValueTooLarge(uint256 requested, uint256 maximum);
    error ZeroValue();

    /// @param admin              Receives DEFAULT_ADMIN_ROLE, GOVERNOR_ROLE, PAUSER_ROLE.
    /// @param paymentToken       AIM token address.
    /// @param modelRegistry      ModelRegistry address.
    /// @param complianceRegistry ComplianceRegistry address.
    /// @param treasury_          Fee destination.
    /// @param protocolFeeBps_    Initial protocol fee in basis points.
    /// @param revealWindow_      Initial reveal window in seconds.
    constructor(
        address admin,
        address paymentToken,
        address modelRegistry,
        address complianceRegistry,
        address treasury_,
        uint256 protocolFeeBps_,
        uint256 revealWindow_
    ) {
        if (admin == address(0)) revert ZeroAddress();
        if (paymentToken == address(0)) revert ZeroAddress();
        if (modelRegistry == address(0)) revert ZeroAddress();
        if (complianceRegistry == address(0)) revert ZeroAddress();
        if (treasury_ == address(0)) revert ZeroAddress();
        if (protocolFeeBps_ > MAX_PROTOCOL_FEE_BPS) {
            revert ValueTooLarge(protocolFeeBps_, MAX_PROTOCOL_FEE_BPS);
        }
        if (revealWindow_ == 0) revert ZeroValue();
        if (revealWindow_ > MAX_REVEAL_WINDOW) revert ValueTooLarge(revealWindow_, MAX_REVEAL_WINDOW);

        PAYMENT_TOKEN = IERC20(paymentToken);
        MODEL_REGISTRY = IModelRegistryView(modelRegistry);
        COMPLIANCE_REGISTRY = IComplianceView(complianceRegistry);
        treasury = treasury_;
        protocolFeeBps = protocolFeeBps_;
        revealWindow = revealWindow_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNOR_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    // ---------------------------------------------------------------- listings

    /// @notice List a model at a fixed price. Provider only.
    /// @dev Requires the model to be listable, which means active in the registry AND its
    ///      provider still adequately bonded.
    function createListing(uint256 modelId, uint256 price) external {
        if (price == 0) revert ZeroPrice();
        if (listings[modelId].exists) revert ListingAlreadyExists(modelId);
        if (MODEL_REGISTRY.getModelProvider(modelId) != msg.sender) {
            revert NotModelProvider(modelId, msg.sender);
        }
        if (!MODEL_REGISTRY.isListable(modelId)) revert ModelNotListable(modelId);

        listings[modelId] = Listing({price: price, active: true, exists: true});
        emit ListingCreated(modelId, msg.sender, price);
    }

    /// @notice Change a listing's price. Provider only.
    function updatePrice(uint256 modelId, uint256 newPrice) external {
        if (newPrice == 0) revert ZeroPrice();
        Listing storage listing = _requireListing(modelId);
        if (!listing.active) revert ListingInactive(modelId);
        if (MODEL_REGISTRY.getModelProvider(modelId) != msg.sender) {
            revert NotModelProvider(modelId, msg.sender);
        }

        emit ListingPriceUpdated(modelId, listing.price, newPrice);
        listing.price = newPrice;
    }

    /// @notice Withdraw a listing. Existing licences remain valid.
    function delist(uint256 modelId) external {
        Listing storage listing = _requireListing(modelId);
        if (!listing.active) revert ListingInactive(modelId);
        if (MODEL_REGISTRY.getModelProvider(modelId) != msg.sender) {
            revert NotModelProvider(modelId, msg.sender);
        }

        listing.active = false;
        emit ListingDelisted(modelId);
    }

    // ---------------------------------------------------------------- purchase

    /// @notice Commit to a purchase without revealing which model.
    /// @dev The digest is keccak256(abi.encode(modelId, buyer, salt)), computed off-chain.
    ///      `escrowAmount` may exceed the price; the surplus is refunded at reveal, which
    ///      lets a buyer obscure the price bracket as well as the model.
    function commitPurchase(bytes32 commitment, uint256 escrowAmount)
        external
        nonReentrant
        whenNotPaused
    {
        if (commitment == bytes32(0)) revert EmptyCommitment();
        if (escrowAmount == 0) revert ZeroAmount();
        if (commitments[commitment].committedAt != 0) revert CommitmentExists(commitment);

        // Evaluated now and recorded, so a later expiry cannot strand this settlement.
        bool compliant = COMPLIANCE_REGISTRY.isCompliant(msg.sender);

        commitments[commitment] = Commitment({
            buyer: msg.sender,
            escrow: escrowAmount,
            committedAt: block.timestamp,
            compliantAtCommit: compliant,
            settled: false
        });
        totalEscrowed += escrowAmount;

        PAYMENT_TOKEN.safeTransferFrom(msg.sender, address(this), escrowAmount);
        emit PurchaseCommitted(commitment, msg.sender, escrowAmount);
    }

    /// @notice Reveal a commitment and settle the licence purchase.
    /// @dev Splits the price into a protocol fee and the provider's share, refunds any
    ///      surplus escrow, and grants the licence. Open while paused by design.
    function revealPurchase(uint256 modelId, bytes32 salt) external nonReentrant {
        bytes32 digest = computeCommitment(modelId, msg.sender, salt);

        Commitment storage c = commitments[digest];
        if (c.committedAt == 0) revert CommitmentNotFound(digest);
        if (c.settled) revert CommitmentSettled(digest);
        if (c.buyer != msg.sender) revert NotCommitmentOwner(digest, msg.sender);

        uint256 deadline = c.committedAt + revealWindow;
        if (block.timestamp > deadline) revert RevealWindowExpired(deadline);

        Listing storage listing = _requireListing(modelId);
        if (!listing.active) revert ListingInactive(modelId);
        if (!MODEL_REGISTRY.isListable(modelId)) revert ModelNotListable(modelId);
        if (hasLicense[modelId][msg.sender]) revert AlreadyLicensed(modelId, msg.sender);

        // High-risk models require an attestation that was valid at commit time.
        if (MODEL_REGISTRY.isHighRisk(modelId) && !c.compliantAtCommit) {
            revert ComplianceRequired(msg.sender);
        }

        uint256 price = listing.price;
        uint256 escrow = c.escrow;
        if (escrow < price) revert InsufficientEscrow(escrow, price);

        uint256 fee = (price * protocolFeeBps) / BPS_DENOMINATOR;
        uint256 providerShare = price - fee;
        uint256 refund = escrow - price;
        address provider = MODEL_REGISTRY.getModelProvider(modelId);

        // All state written before any transfer.
        c.settled = true;
        totalEscrowed -= escrow;
        lifetimeFees += fee;
        hasLicense[modelId][msg.sender] = true;

        if (fee > 0) {
            PAYMENT_TOKEN.safeTransfer(treasury, fee);
        }
        PAYMENT_TOKEN.safeTransfer(provider, providerShare);
        if (refund > 0) {
            PAYMENT_TOKEN.safeTransfer(msg.sender, refund);
        }

        emit PurchaseRevealed(modelId, msg.sender, price, fee);
    }

    /// @notice Reclaim escrow from an unrevealed commitment after the window closes.
    /// @dev Prevents funds being locked forever if a buyer loses their salt or abandons the
    ///      purchase. Open while paused by design.
    function cancelCommitment(bytes32 commitment) external nonReentrant {
        Commitment storage c = commitments[commitment];
        if (c.committedAt == 0) revert CommitmentNotFound(commitment);
        if (c.settled) revert CommitmentSettled(commitment);
        if (c.buyer != msg.sender) revert NotCommitmentOwner(commitment, msg.sender);

        uint256 closesAt = c.committedAt + revealWindow;
        if (block.timestamp <= closesAt) revert RevealWindowOpen(closesAt);

        uint256 refund = c.escrow;
        c.settled = true;
        totalEscrowed -= refund;

        PAYMENT_TOKEN.safeTransfer(msg.sender, refund);
        emit CommitmentCancelled(commitment, msg.sender, refund);
    }

    // ---------------------------------------------------------------- views

    /// @notice Compute a purchase commitment. Pure, so buyers may use it off-chain.
    function computeCommitment(uint256 modelId, address buyer, bytes32 salt)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(modelId, buyer, salt));
    }

    /// @notice Whether a model is currently purchasable.
    function isPurchasable(uint256 modelId) external view returns (bool) {
        Listing storage listing = listings[modelId];
        if (!listing.exists || !listing.active) return false;
        return MODEL_REGISTRY.isListable(modelId);
    }

    /// @notice Contract holdings against escrow obligations. `held` must never be less
    ///         than `owed`.
    function solvency() external view returns (uint256 held, uint256 owed) {
        held = PAYMENT_TOKEN.balanceOf(address(this));
        owed = totalEscrowed;
    }

    // ---------------------------------------------------------------- parameters

    /// @notice Set the protocol fee.
    function setProtocolFeeBps(uint256 newFeeBps) external onlyRole(GOVERNOR_ROLE) {
        if (newFeeBps > MAX_PROTOCOL_FEE_BPS) revert ValueTooLarge(newFeeBps, MAX_PROTOCOL_FEE_BPS);
        emit ParameterUpdated("protocolFeeBps", protocolFeeBps, newFeeBps);
        protocolFeeBps = newFeeBps;
    }

    /// @notice Set the reveal window.
    function setRevealWindow(uint256 newWindow) external onlyRole(GOVERNOR_ROLE) {
        if (newWindow == 0) revert ZeroValue();
        if (newWindow > MAX_REVEAL_WINDOW) revert ValueTooLarge(newWindow, MAX_REVEAL_WINDOW);
        emit ParameterUpdated("revealWindow", revealWindow, newWindow);
        revealWindow = newWindow;
    }

    /// @notice Set the fee destination.
    function setTreasury(address newTreasury) external onlyRole(GOVERNOR_ROLE) {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    // ---------------------------------------------------------------- emergency

    /// @notice Block new commitments. Reveal and cancel remain available.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Resume commitments.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------- internal

    function _requireListing(uint256 modelId) internal view returns (Listing storage listing) {
        listing = listings[modelId];
        if (!listing.exists) revert ListingNotFound(modelId);
    }
}
