const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const E = (n) => ethers.parseEther(n.toString());
const DAY = 24 * 60 * 60;

const FEE_BPS = 500; // 5 percent
const REVEAL_WINDOW = 7 * DAY;
const PRICE = E(1000);
const SALT = ethers.keccak256(ethers.toUtf8Bytes("purchase-salt-1"));
const DOC = ethers.keccak256(ethers.toUtf8Bytes("kyc-bundle"));

describe("Marketplace", function () {
  let token, registry, compliance, market;
  let admin, treasury, provider, buyer, buyer2, outsider;

  beforeEach(async function () {
    [admin, treasury, provider, buyer, buyer2, outsider] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("AIMToken");
    token = await Token.deploy(
      admin.address,
      treasury.address,
      provider.address,
      buyer.address,
      buyer2.address
    );
    await token.waitForDeployment();

    const Registry = await ethers.getContractFactory("MockModelRegistry");
    registry = await Registry.deploy();
    await registry.waitForDeployment();
    await registry.setModel(1, provider.address, true, false); // minimal risk
    await registry.setModel(2, provider.address, true, true); // high risk

    const Compliance = await ethers.getContractFactory("ComplianceRegistry");
    compliance = await Compliance.deploy(admin.address);
    await compliance.waitForDeployment();

    const Market = await ethers.getContractFactory("Marketplace");
    market = await Market.deploy(
      admin.address,
      await token.getAddress(),
      await registry.getAddress(),
      await compliance.getAddress(),
      treasury.address,
      FEE_BPS,
      REVEAL_WINDOW
    );
    await market.waitForDeployment();

    await market.connect(provider).createListing(1, PRICE);
    await market.connect(provider).createListing(2, PRICE);

    for (const b of [buyer, buyer2]) {
      await token.connect(b).approve(await market.getAddress(), E(1_000_000));
    }
  });

  async function commitFor(signer, modelId, escrow = PRICE, salt = SALT) {
    const digest = await market.computeCommitment(modelId, signer.address, salt);
    await market.connect(signer).commitPurchase(digest, escrow);
    return digest;
  }

  describe("constructor", function () {
    it("stores configuration and grants roles", async function () {
      expect(await market.PAYMENT_TOKEN()).to.equal(await token.getAddress());
      expect(await market.treasury()).to.equal(treasury.address);
      expect(await market.protocolFeeBps()).to.equal(FEE_BPS);
      expect(await market.revealWindow()).to.equal(REVEAL_WINDOW);
      expect(await market.hasRole(await market.GOVERNOR_ROLE(), admin.address)).to.equal(true);
      expect(await market.hasRole(await market.PAUSER_ROLE(), admin.address)).to.equal(true);
    });

    it("reverts on any zero address", async function () {
      const M = await ethers.getContractFactory("Marketplace");
      const t = await token.getAddress();
      const r = await registry.getAddress();
      const c = await compliance.getAddress();
      const Z = ethers.ZeroAddress;

      await expect(M.deploy(Z, t, r, c, treasury.address, FEE_BPS, REVEAL_WINDOW)).to.be.revertedWithCustomError(M, "ZeroAddress");
      await expect(M.deploy(admin.address, Z, r, c, treasury.address, FEE_BPS, REVEAL_WINDOW)).to.be.revertedWithCustomError(M, "ZeroAddress");
      await expect(M.deploy(admin.address, t, Z, c, treasury.address, FEE_BPS, REVEAL_WINDOW)).to.be.revertedWithCustomError(M, "ZeroAddress");
      await expect(M.deploy(admin.address, t, r, Z, treasury.address, FEE_BPS, REVEAL_WINDOW)).to.be.revertedWithCustomError(M, "ZeroAddress");
      await expect(M.deploy(admin.address, t, r, c, Z, FEE_BPS, REVEAL_WINDOW)).to.be.revertedWithCustomError(M, "ZeroAddress");
    });

    it("reverts on a fee above the cap", async function () {
      const M = await ethers.getContractFactory("Marketplace");
      await expect(
        M.deploy(admin.address, await token.getAddress(), await registry.getAddress(), await compliance.getAddress(), treasury.address, 2001, REVEAL_WINDOW)
      ).to.be.revertedWithCustomError(M, "ValueTooLarge");
    });

    it("reverts on a zero or oversized reveal window", async function () {
      const M = await ethers.getContractFactory("Marketplace");
      const args = [admin.address, await token.getAddress(), await registry.getAddress(), await compliance.getAddress(), treasury.address, FEE_BPS];
      await expect(M.deploy(...args, 0)).to.be.revertedWithCustomError(M, "ZeroValue");
      await expect(M.deploy(...args, 31 * DAY)).to.be.revertedWithCustomError(M, "ValueTooLarge");
    });
  });

  describe("listings", function () {
    it("creates a listing and emits", async function () {
      await registry.setModel(3, provider.address, true, false);
      await expect(market.connect(provider).createListing(3, PRICE)).to.emit(market, "ListingCreated");

      const l = await market.listings(3);
      expect(l.price).to.equal(PRICE);
      expect(l.active).to.equal(true);
      expect(l.exists).to.equal(true);
    });

    it("rejects a zero price", async function () {
      await registry.setModel(3, provider.address, true, false);
      await expect(market.connect(provider).createListing(3, 0)).to.be.revertedWithCustomError(market, "ZeroPrice");
    });

    it("rejects a duplicate listing", async function () {
      await expect(market.connect(provider).createListing(1, PRICE)).to.be.revertedWithCustomError(
        market,
        "ListingAlreadyExists"
      );
    });

    it("rejects a non-provider", async function () {
      await registry.setModel(3, provider.address, true, false);
      await expect(market.connect(outsider).createListing(3, PRICE)).to.be.revertedWithCustomError(
        market,
        "NotModelProvider"
      );
    });

    it("rejects a model that is not listable", async function () {
      await registry.setModel(3, provider.address, false, false);
      await expect(market.connect(provider).createListing(3, PRICE)).to.be.revertedWithCustomError(
        market,
        "ModelNotListable"
      );
    });

    it("updates the price", async function () {
      await expect(market.connect(provider).updatePrice(1, E(2000))).to.emit(market, "ListingPriceUpdated");
      expect((await market.listings(1)).price).to.equal(E(2000));
    });

    it("rejects a zero price update", async function () {
      await expect(market.connect(provider).updatePrice(1, 0)).to.be.revertedWithCustomError(market, "ZeroPrice");
    });

    it("rejects a price update from a non-provider", async function () {
      await expect(market.connect(outsider).updatePrice(1, E(2000))).to.be.revertedWithCustomError(
        market,
        "NotModelProvider"
      );
    });

    it("rejects a price update on an unknown listing", async function () {
      await expect(market.connect(provider).updatePrice(99, PRICE)).to.be.revertedWithCustomError(
        market,
        "ListingNotFound"
      );
    });

    it("delists and blocks further updates", async function () {
      await expect(market.connect(provider).delist(1)).to.emit(market, "ListingDelisted");
      expect(await market.isPurchasable(1)).to.equal(false);
      await expect(market.connect(provider).updatePrice(1, PRICE)).to.be.revertedWithCustomError(
        market,
        "ListingInactive"
      );
    });

    it("rejects delisting twice", async function () {
      await market.connect(provider).delist(1);
      await expect(market.connect(provider).delist(1)).to.be.revertedWithCustomError(market, "ListingInactive");
    });

    it("rejects delisting by a non-provider", async function () {
      await expect(market.connect(outsider).delist(1)).to.be.revertedWithCustomError(market, "NotModelProvider");
    });

    it("rejects delisting an unknown listing", async function () {
      await expect(market.connect(provider).delist(99)).to.be.revertedWithCustomError(market, "ListingNotFound");
    });
  });

  describe("commitPurchase", function () {
    it("escrows funds and reveals nothing about the model", async function () {
      const digest = await commitFor(buyer, 1);

      const c = await market.commitments(digest);
      expect(c.buyer).to.equal(buyer.address);
      expect(c.escrow).to.equal(PRICE);
      expect(c.settled).to.equal(false);
      expect(await market.totalEscrowed()).to.equal(PRICE);
      expect(await token.balanceOf(await market.getAddress())).to.equal(PRICE);
    });

    it("emits only the digest and the escrow amount", async function () {
      const digest = await market.computeCommitment(1, buyer.address, SALT);
      await expect(market.connect(buyer).commitPurchase(digest, PRICE))
        .to.emit(market, "PurchaseCommitted")
        .withArgs(digest, buyer.address, PRICE);
    });

    it("records compliance status at commit time", async function () {
      await compliance.grantAttestation(buyer.address, DOC, 365 * DAY);
      const digest = await commitFor(buyer, 2);
      expect((await market.commitments(digest)).compliantAtCommit).to.equal(true);
    });

    it("records non-compliance when unattested", async function () {
      const digest = await commitFor(buyer, 1);
      expect((await market.commitments(digest)).compliantAtCommit).to.equal(false);
    });

    it("rejects an empty commitment", async function () {
      await expect(market.connect(buyer).commitPurchase(ethers.ZeroHash, PRICE)).to.be.revertedWithCustomError(
        market,
        "EmptyCommitment"
      );
    });

    it("rejects a zero escrow", async function () {
      const digest = await market.computeCommitment(1, buyer.address, SALT);
      await expect(market.connect(buyer).commitPurchase(digest, 0)).to.be.revertedWithCustomError(market, "ZeroAmount");
    });

    it("rejects a duplicate commitment", async function () {
      const digest = await commitFor(buyer, 1);
      await expect(market.connect(buyer).commitPurchase(digest, PRICE)).to.be.revertedWithCustomError(
        market,
        "CommitmentExists"
      );
    });
  });

  describe("revealPurchase", function () {
    it("settles, splits the fee and grants the licence", async function () {
      await commitFor(buyer, 1);

      const providerBefore = await token.balanceOf(provider.address);
      const treasuryBefore = await token.balanceOf(treasury.address);

      await expect(market.connect(buyer).revealPurchase(1, SALT))
        .to.emit(market, "PurchaseRevealed")
        .withArgs(1, buyer.address, PRICE, E(50));

      expect(await token.balanceOf(treasury.address)).to.equal(treasuryBefore + E(50));
      expect(await token.balanceOf(provider.address)).to.equal(providerBefore + E(950));
      expect(await market.hasLicense(1, buyer.address)).to.equal(true);
      expect(await market.totalEscrowed()).to.equal(0);
      expect(await market.lifetimeFees()).to.equal(E(50));
    });

    it("refunds surplus escrow, so buyers can obscure the price bracket", async function () {
      await commitFor(buyer, 1, E(5000));
      const before = await token.balanceOf(buyer.address);

      await market.connect(buyer).revealPurchase(1, SALT);

      // Paid 1000, so 4000 comes back.
      expect(await token.balanceOf(buyer.address)).to.equal(before + E(4000));
      expect(await market.totalEscrowed()).to.equal(0);
    });

    it("permits a zero fee", async function () {
      await market.setProtocolFeeBps(0);
      await commitFor(buyer, 1);
      const treasuryBefore = await token.balanceOf(treasury.address);

      await market.connect(buyer).revealPurchase(1, SALT);
      expect(await token.balanceOf(treasury.address)).to.equal(treasuryBefore);
    });

    it("allows two buyers to license the same model", async function () {
      await commitFor(buyer, 1);
      await commitFor(buyer2, 1);

      await market.connect(buyer).revealPurchase(1, SALT);
      await market.connect(buyer2).revealPurchase(1, SALT);

      expect(await market.hasLicense(1, buyer.address)).to.equal(true);
      expect(await market.hasLicense(1, buyer2.address)).to.equal(true);
    });

    it("rejects a reveal with the wrong salt", async function () {
      await commitFor(buyer, 1);
      const wrong = ethers.keccak256(ethers.toUtf8Bytes("wrong-salt"));
      await expect(market.connect(buyer).revealPurchase(1, wrong)).to.be.revertedWithCustomError(
        market,
        "CommitmentNotFound"
      );
    });

    it("rejects a reveal by someone other than the committer", async function () {
      await commitFor(buyer, 1);
      // A different caller produces a different digest, so no commitment is found.
      await expect(market.connect(outsider).revealPurchase(1, SALT)).to.be.revertedWithCustomError(
        market,
        "CommitmentNotFound"
      );
    });

    it("rejects a double reveal", async function () {
      await commitFor(buyer, 1);
      await market.connect(buyer).revealPurchase(1, SALT);
      await expect(market.connect(buyer).revealPurchase(1, SALT)).to.be.revertedWithCustomError(
        market,
        "CommitmentSettled"
      );
    });

    it("rejects a reveal after the window expires", async function () {
      await commitFor(buyer, 1);
      await time.increase(REVEAL_WINDOW + 1);
      await expect(market.connect(buyer).revealPurchase(1, SALT)).to.be.revertedWithCustomError(
        market,
        "RevealWindowExpired"
      );
    });

    it("rejects a reveal with insufficient escrow", async function () {
      await commitFor(buyer, 1, E(500));
      await expect(market.connect(buyer).revealPurchase(1, SALT)).to.be.revertedWithCustomError(
        market,
        "InsufficientEscrow"
      );
    });

    it("rejects a reveal against a delisted listing", async function () {
      await commitFor(buyer, 1);
      await market.connect(provider).delist(1);
      await expect(market.connect(buyer).revealPurchase(1, SALT)).to.be.revertedWithCustomError(
        market,
        "ListingInactive"
      );
    });

    it("rejects a reveal when the model stopped being listable", async function () {
      await commitFor(buyer, 1);
      // Simulates the provider being slashed below the bond threshold.
      await registry.setListable(1, false);
      await expect(market.connect(buyer).revealPurchase(1, SALT)).to.be.revertedWithCustomError(
        market,
        "ModelNotListable"
      );
    });

    it("rejects a reveal against an unknown listing", async function () {
      const digest = await market.computeCommitment(99, buyer.address, SALT);
      await market.connect(buyer).commitPurchase(digest, PRICE);
      await expect(market.connect(buyer).revealPurchase(99, SALT)).to.be.revertedWithCustomError(
        market,
        "ListingNotFound"
      );
    });

    it("rejects a second licence for the same buyer and model", async function () {
      await commitFor(buyer, 1);
      await market.connect(buyer).revealPurchase(1, SALT);

      const salt2 = ethers.keccak256(ethers.toUtf8Bytes("purchase-salt-2"));
      await commitFor(buyer, 1, PRICE, salt2);
      await expect(market.connect(buyer).revealPurchase(1, salt2)).to.be.revertedWithCustomError(
        market,
        "AlreadyLicensed"
      );
    });

    describe("high-risk compliance gate", function () {
      it("settles when the buyer was attested at commit", async function () {
        await compliance.grantAttestation(buyer.address, DOC, 365 * DAY);
        await commitFor(buyer, 2);
        await market.connect(buyer).revealPurchase(2, SALT);
        expect(await market.hasLicense(2, buyer.address)).to.equal(true);
      });

      it("rejects an unattested buyer", async function () {
        await commitFor(buyer, 2);
        await expect(market.connect(buyer).revealPurchase(2, SALT)).to.be.revertedWithCustomError(
          market,
          "ComplianceRequired"
        );
      });

      it("still settles when the attestation expires mid-flight", async function () {
        // The interface commitment made to ComplianceRegistry: status is evaluated at
        // commit and recorded, so a later expiry cannot strand an in-flight settlement.
        await compliance.grantAttestation(buyer.address, DOC, 2 * DAY);
        await commitFor(buyer, 2);

        await time.increase(3 * DAY);
        expect(await compliance.isCompliant(buyer.address)).to.equal(false);

        await market.connect(buyer).revealPurchase(2, SALT);
        expect(await market.hasLicense(2, buyer.address)).to.equal(true);
      });

      it("does not gate a minimal-risk model on compliance", async function () {
        await commitFor(buyer, 1);
        await market.connect(buyer).revealPurchase(1, SALT);
        expect(await market.hasLicense(1, buyer.address)).to.equal(true);
      });
    });
  });

  describe("cancelCommitment", function () {
    it("refunds escrow after the window closes", async function () {
      const digest = await commitFor(buyer, 1, E(2000));
      const before = await token.balanceOf(buyer.address);

      await time.increase(REVEAL_WINDOW + 1);
      await expect(market.connect(buyer).cancelCommitment(digest)).to.emit(market, "CommitmentCancelled");

      expect(await token.balanceOf(buyer.address)).to.equal(before + E(2000));
      expect(await market.totalEscrowed()).to.equal(0);
    });

    it("rejects cancellation while the window is open", async function () {
      const digest = await commitFor(buyer, 1);
      await expect(market.connect(buyer).cancelCommitment(digest)).to.be.revertedWithCustomError(
        market,
        "RevealWindowOpen"
      );
    });

    it("rejects cancellation by a non-owner", async function () {
      const digest = await commitFor(buyer, 1);
      await time.increase(REVEAL_WINDOW + 1);
      await expect(market.connect(outsider).cancelCommitment(digest)).to.be.revertedWithCustomError(
        market,
        "NotCommitmentOwner"
      );
    });

    it("rejects cancellation of an unknown commitment", async function () {
      await expect(
        market.connect(buyer).cancelCommitment(ethers.keccak256(ethers.toUtf8Bytes("nope")))
      ).to.be.revertedWithCustomError(market, "CommitmentNotFound");
    });

    it("rejects cancellation after settlement", async function () {
      const digest = await commitFor(buyer, 1);
      await market.connect(buyer).revealPurchase(1, SALT);
      await time.increase(REVEAL_WINDOW + 1);
      await expect(market.connect(buyer).cancelCommitment(digest)).to.be.revertedWithCustomError(
        market,
        "CommitmentSettled"
      );
    });

    it("rejects a double cancellation", async function () {
      const digest = await commitFor(buyer, 1);
      await time.increase(REVEAL_WINDOW + 1);
      await market.connect(buyer).cancelCommitment(digest);
      await expect(market.connect(buyer).cancelCommitment(digest)).to.be.revertedWithCustomError(
        market,
        "CommitmentSettled"
      );
    });
  });

  describe("solvency", function () {
    it("holds at least the escrowed total at every stage", async function () {
      await commitFor(buyer, 1, E(3000));
      await commitFor(buyer2, 1, E(2000));

      let [held, owed] = await market.solvency();
      expect(held).to.equal(E(5000));
      expect(owed).to.equal(E(5000));

      await market.connect(buyer).revealPurchase(1, SALT);
      [held, owed] = await market.solvency();
      expect(held).to.be.greaterThanOrEqual(owed);
      expect(owed).to.equal(E(2000));
    });
  });

  describe("isPurchasable", function () {
    it("is false for a model with no listing", async function () {
      expect(await market.isPurchasable(99)).to.equal(false);
    });

    it("is true for an active listing on a listable model", async function () {
      expect(await market.isPurchasable(1)).to.equal(true);
    });

    it("is false once the registry stops reporting the model as listable", async function () {
      await registry.setListable(1, false);
      expect(await market.isPurchasable(1)).to.equal(false);
    });
  });

  describe("parameters", function () {
    it("sets the fee", async function () {
      await expect(market.setProtocolFeeBps(1000)).to.emit(market, "ParameterUpdated");
      expect(await market.protocolFeeBps()).to.equal(1000);
    });

    it("rejects a fee above the cap", async function () {
      await expect(market.setProtocolFeeBps(2001)).to.be.revertedWithCustomError(market, "ValueTooLarge");
    });

    it("sets the reveal window", async function () {
      await market.setRevealWindow(14 * DAY);
      expect(await market.revealWindow()).to.equal(14 * DAY);
    });

    it("rejects a zero reveal window", async function () {
      await expect(market.setRevealWindow(0)).to.be.revertedWithCustomError(market, "ZeroValue");
    });

    it("rejects a reveal window above the cap", async function () {
      await expect(market.setRevealWindow(31 * DAY)).to.be.revertedWithCustomError(market, "ValueTooLarge");
    });

    it("sets the treasury", async function () {
      await expect(market.setTreasury(outsider.address)).to.emit(market, "TreasuryUpdated");
      expect(await market.treasury()).to.equal(outsider.address);
    });

    it("rejects a zero treasury", async function () {
      await expect(market.setTreasury(ethers.ZeroAddress)).to.be.revertedWithCustomError(market, "ZeroAddress");
    });

    it("rejects a non-governor", async function () {
      await expect(market.connect(outsider).setProtocolFeeBps(0)).to.be.revertedWithCustomError(
        market,
        "AccessControlUnauthorizedAccount"
      );
    });
  });

  describe("pause", function () {
    it("blocks new commitments", async function () {
      await market.pause();
      const digest = await market.computeCommitment(1, buyer.address, SALT);
      await expect(market.connect(buyer).commitPurchase(digest, PRICE)).to.be.revertedWithCustomError(
        market,
        "EnforcedPause"
      );
    });

    it("never traps escrowed funds: reveal still works", async function () {
      await commitFor(buyer, 1);
      await market.pause();
      await market.connect(buyer).revealPurchase(1, SALT);
      expect(await market.hasLicense(1, buyer.address)).to.equal(true);
    });

    it("never traps escrowed funds: cancel still works", async function () {
      const digest = await commitFor(buyer, 1);
      await market.pause();
      await time.increase(REVEAL_WINDOW + 1);
      await market.connect(buyer).cancelCommitment(digest);
      expect(await market.totalEscrowed()).to.equal(0);
    });

    it("resumes after unpause", async function () {
      await market.pause();
      await market.unpause();
      await commitFor(buyer, 1);
      expect(await market.totalEscrowed()).to.equal(PRICE);
    });

    it("rejects a non-pauser", async function () {
      await expect(market.connect(outsider).pause()).to.be.revertedWithCustomError(
        market,
        "AccessControlUnauthorizedAccount"
      );
    });
  });
});
