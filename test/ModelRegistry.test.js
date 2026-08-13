const { expect } = require("chai");
const { ethers } = require("hardhat");

const CID = ethers.keccak256(ethers.toUtf8Bytes("ipfs://model-metadata-v1"));
const CID2 = ethers.keccak256(ethers.toUtf8Bytes("ipfs://model-metadata-v2"));

// RiskTier enum
const MINIMAL = 0;
const LIMITED = 1;
const HIGH_RISK = 2;
const UNACCEPTABLE = 3;

// Status enum
const ACTIVE = 0;
const SUSPENDED = 1;
const RETIRED = 2;

describe("ModelRegistry", function () {
  let registry, bond;
  let admin, curator, governor, provider, other, outsider;

  beforeEach(async function () {
    [admin, curator, governor, provider, other, outsider] = await ethers.getSigners();

    const Bond = await ethers.getContractFactory("MockStakingBond");
    bond = await Bond.deploy();
    await bond.waitForDeployment();

    const Registry = await ethers.getContractFactory("ModelRegistry");
    registry = await Registry.deploy(admin.address, await bond.getAddress());
    await registry.waitForDeployment();

    await registry.grantRole(await registry.CURATOR_ROLE(), curator.address);
    await registry.grantRole(await registry.GOVERNOR_ROLE(), governor.address);

    await bond.setBonded(provider.address, true);
    await bond.setBonded(other.address, true);
  });

  async function register(signer = provider, tier = MINIMAL, cid = CID) {
    await registry.connect(signer).registerModel(cid, tier);
    return registry.modelCount();
  }

  describe("constructor", function () {
    it("stores the bond source and grants launch roles", async function () {
      expect(await registry.stakingVault()).to.equal(await bond.getAddress());
      expect(await registry.hasRole(await registry.CURATOR_ROLE(), admin.address)).to.equal(true);
      expect(await registry.hasRole(await registry.GOVERNOR_ROLE(), admin.address)).to.equal(true);
    });

    it("reverts on a zero admin", async function () {
      const Registry = await ethers.getContractFactory("ModelRegistry");
      await expect(
        Registry.deploy(ethers.ZeroAddress, await bond.getAddress())
      ).to.be.revertedWithCustomError(Registry, "ZeroAddress");
    });

    it("reverts on a zero staking vault", async function () {
      const Registry = await ethers.getContractFactory("ModelRegistry");
      await expect(
        Registry.deploy(admin.address, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(Registry, "ZeroAddress");
    });
  });

  describe("registerModel", function () {
    it("assigns sequential ids starting at one", async function () {
      await register(provider);
      expect(await registry.modelCount()).to.equal(1);
      await register(other);
      expect(await registry.modelCount()).to.equal(2);
    });

    it("stores the full record and emits", async function () {
      await expect(registry.connect(provider).registerModel(CID, LIMITED)).to.emit(
        registry,
        "ModelRegistered"
      );

      const m = await registry.getModel(1);
      expect(m.provider).to.equal(provider.address);
      expect(m.metadataCID).to.equal(CID);
      expect(m.riskTier).to.equal(LIMITED);
      expect(m.status).to.equal(ACTIVE);
      expect(m.registeredAt).to.be.greaterThan(0);
    });

    it("tracks per-provider counts", async function () {
      await register(provider);
      await register(provider, MINIMAL, CID2);
      expect(await registry.providerModelCount(provider.address)).to.equal(2);
      expect(await registry.providerModelCount(other.address)).to.equal(0);
    });

    it("accepts a high-risk declaration", async function () {
      await register(provider, HIGH_RISK);
      expect(await registry.isHighRisk(1)).to.equal(true);
    });

    it("reports non-high-risk tiers correctly", async function () {
      await register(provider, MINIMAL);
      expect(await registry.isHighRisk(1)).to.equal(false);
    });

    it("rejects an unacceptable risk tier outright", async function () {
      await expect(
        registry.connect(provider).registerModel(CID, UNACCEPTABLE)
      ).to.be.revertedWithCustomError(registry, "UnacceptableRiskTier");
    });

    it("rejects an empty CID", async function () {
      await expect(
        registry.connect(provider).registerModel(ethers.ZeroHash, MINIMAL)
      ).to.be.revertedWithCustomError(registry, "EmptyCID");
    });

    it("rejects an unbonded provider", async function () {
      await expect(
        registry.connect(outsider).registerModel(CID, MINIMAL)
      ).to.be.revertedWithCustomError(registry, "ProviderNotBonded");
    });
  });

  describe("updateMetadata", function () {
    beforeEach(async function () {
      await register(provider);
    });

    it("replaces the CID and emits both values", async function () {
      await expect(registry.connect(provider).updateMetadata(1, CID2))
        .to.emit(registry, "ModelUpdated")
        .withArgs(1, CID, CID2);

      const m = await registry.getModel(1);
      expect(m.metadataCID).to.equal(CID2);
    });

    it("rejects a caller who is not the provider", async function () {
      await expect(
        registry.connect(other).updateMetadata(1, CID2)
      ).to.be.revertedWithCustomError(registry, "NotModelProvider");
    });

    it("rejects an empty CID", async function () {
      await expect(
        registry.connect(provider).updateMetadata(1, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(registry, "EmptyCID");
    });

    it("rejects an unknown model", async function () {
      await expect(
        registry.connect(provider).updateMetadata(99, CID2)
      ).to.be.revertedWithCustomError(registry, "ModelNotFound");
    });

    it("rejects an update while suspended", async function () {
      await registry.connect(curator).suspendModel(1);
      await expect(
        registry.connect(provider).updateMetadata(1, CID2)
      ).to.be.revertedWithCustomError(registry, "ModelNotActive");
    });

    it("rejects an update after retirement", async function () {
      await registry.connect(provider).retireModel(1);
      await expect(
        registry.connect(provider).updateMetadata(1, CID2)
      ).to.be.revertedWithCustomError(registry, "ModelNotActive");
    });
  });

  describe("suspension", function () {
    beforeEach(async function () {
      await register(provider);
    });

    it("lets a curator suspend an active model", async function () {
      await expect(registry.connect(curator).suspendModel(1)).to.emit(registry, "ModelSuspended");
      expect((await registry.getModel(1)).status).to.equal(SUSPENDED);
    });

    it("removes the model from listable while suspended", async function () {
      await registry.connect(curator).suspendModel(1);
      expect(await registry.isListable(1)).to.equal(false);
    });

    it("rejects a non-curator suspending", async function () {
      await expect(
        registry.connect(outsider).suspendModel(1)
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });

    it("rejects suspending an already suspended model", async function () {
      await registry.connect(curator).suspendModel(1);
      await expect(
        registry.connect(curator).suspendModel(1)
      ).to.be.revertedWithCustomError(registry, "ModelNotActive");
    });

    it("rejects suspending a retired model", async function () {
      await registry.connect(provider).retireModel(1);
      await expect(
        registry.connect(curator).suspendModel(1)
      ).to.be.revertedWithCustomError(registry, "ModelNotActive");
    });

    it("rejects suspending an unknown model", async function () {
      await expect(
        registry.connect(curator).suspendModel(99)
      ).to.be.revertedWithCustomError(registry, "ModelNotFound");
    });

    it("lets a curator reinstate", async function () {
      await registry.connect(curator).suspendModel(1);
      await expect(registry.connect(curator).unsuspendModel(1)).to.emit(registry, "ModelUnsuspended");
      expect(await registry.isListable(1)).to.equal(true);
    });

    it("lets a governor override a curator suspension", async function () {
      await registry.connect(curator).suspendModel(1);
      await registry.connect(governor).unsuspendModel(1);
      expect((await registry.getModel(1)).status).to.equal(ACTIVE);
    });

    it("rejects reinstatement by someone holding neither role", async function () {
      await registry.connect(curator).suspendModel(1);
      await expect(
        registry.connect(outsider).unsuspendModel(1)
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });

    it("rejects reinstating a model that is not suspended", async function () {
      await expect(
        registry.connect(curator).unsuspendModel(1)
      ).to.be.revertedWithCustomError(registry, "ModelNotSuspended");
    });

    it("rejects reinstating an unknown model", async function () {
      await expect(
        registry.connect(curator).unsuspendModel(99)
      ).to.be.revertedWithCustomError(registry, "ModelNotFound");
    });
  });

  describe("retirement", function () {
    beforeEach(async function () {
      await register(provider);
    });

    it("lets the provider retire and emits", async function () {
      await expect(registry.connect(provider).retireModel(1)).to.emit(registry, "ModelRetired");
      expect((await registry.getModel(1)).status).to.equal(RETIRED);
    });

    it("removes the model from listable", async function () {
      await registry.connect(provider).retireModel(1);
      expect(await registry.isListable(1)).to.equal(false);
    });

    it("permits retiring from suspended", async function () {
      await registry.connect(curator).suspendModel(1);
      await registry.connect(provider).retireModel(1);
      expect((await registry.getModel(1)).status).to.equal(RETIRED);
    });

    it("is irreversible", async function () {
      await registry.connect(provider).retireModel(1);
      await expect(
        registry.connect(provider).retireModel(1)
      ).to.be.revertedWithCustomError(registry, "ModelRetiredPermanently");
      await expect(
        registry.connect(curator).unsuspendModel(1)
      ).to.be.revertedWithCustomError(registry, "ModelNotSuspended");
    });

    it("rejects a curator retiring someone else's model", async function () {
      await expect(
        registry.connect(curator).retireModel(1)
      ).to.be.revertedWithCustomError(registry, "NotModelProvider");
    });

    it("rejects an unknown model", async function () {
      await expect(
        registry.connect(provider).retireModel(99)
      ).to.be.revertedWithCustomError(registry, "ModelNotFound");
    });
  });

  describe("isListable", function () {
    it("is true for an active model with a bonded provider", async function () {
      await register(provider);
      expect(await registry.isListable(1)).to.equal(true);
    });

    it("is false for an unknown model", async function () {
      expect(await registry.isListable(99)).to.equal(false);
    });

    it("becomes false when the provider's bond falls below threshold", async function () {
      await register(provider);
      expect(await registry.isListable(1)).to.equal(true);

      // Simulates the provider being slashed below the minimum bond.
      await bond.setBonded(provider.address, false);
      expect(await registry.isListable(1)).to.equal(false);

      // Listing state itself is untouched.
      expect((await registry.getModel(1)).status).to.equal(ACTIVE);
    });
  });

  describe("view guards", function () {
    it("getModel reverts on an unknown model", async function () {
      await expect(registry.getModel(99)).to.be.revertedWithCustomError(registry, "ModelNotFound");
    });

    it("isHighRisk reverts on an unknown model", async function () {
      await expect(registry.isHighRisk(99)).to.be.revertedWithCustomError(registry, "ModelNotFound");
    });

    it("getModelProvider returns the provider", async function () {
      await register(provider);
      expect(await registry.getModelProvider(1)).to.equal(provider.address);
    });

    it("getModelProvider reverts on an unknown model", async function () {
      await expect(registry.getModelProvider(99)).to.be.revertedWithCustomError(
        registry,
        "ModelNotFound"
      );
    });
  });

  describe("setStakingVault", function () {
    it("lets the governor repoint the bond source", async function () {
      const Bond = await ethers.getContractFactory("MockStakingBond");
      const newBond = await Bond.deploy();
      await newBond.waitForDeployment();

      await expect(registry.connect(governor).setStakingVault(await newBond.getAddress())).to.emit(
        registry,
        "StakingVaultUpdated"
      );
      expect(await registry.stakingVault()).to.equal(await newBond.getAddress());
    });

    it("rejects a zero address", async function () {
      await expect(
        registry.connect(governor).setStakingVault(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("rejects a non-governor", async function () {
      await expect(
        registry.connect(outsider).setStakingVault(await bond.getAddress())
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });
  });
});
