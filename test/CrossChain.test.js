const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const E = (n) => ethers.parseEther(n.toString());
const DAY = 24 * 60 * 60;
const CID = ethers.keccak256(ethers.toUtf8Bytes("ipfs://cross-chain-model"));

const MINIMAL = 0;
const HIGH_RISK = 2;

/**
 * Both halves are exercised on a single Hardhat network. Two chains cannot exist in one
 * test process, so the relay is simulated by reading the gateway's event and calling the
 * receiver with the same arguments. That is exactly what the human relayer does between
 * Sepolia Etherscan and Amoy Polygonscan during the live demo, so the test mirrors the
 * real procedure rather than an idealised one.
 */
describe("Cross-chain registry sync", function () {
  let bond, registry, gateway, receiver;
  let admin, relayer, provider, other, outsider;

  beforeEach(async function () {
    [admin, relayer, provider, other, outsider] = await ethers.getSigners();

    const Bond = await ethers.getContractFactory("MockStakingBond");
    bond = await Bond.deploy();
    await bond.waitForDeployment();
    await bond.setBonded(provider.address, true);
    await bond.setBonded(other.address, true);

    // Real ModelRegistry: the gateway must attest genuine registry state.
    const Registry = await ethers.getContractFactory("ModelRegistry");
    registry = await Registry.deploy(admin.address, await bond.getAddress());
    await registry.waitForDeployment();

    const Gateway = await ethers.getContractFactory("RegistryGateway");
    gateway = await Gateway.deploy(admin.address, await registry.getAddress());
    await gateway.waitForDeployment();

    const Receiver = await ethers.getContractFactory("RegistryReceiver");
    receiver = await Receiver.deploy(admin.address, relayer.address);
    await receiver.waitForDeployment();

    await registry.connect(provider).registerModel(CID, MINIMAL);
  });

  /** Reads the gateway's emitted attestation and returns the relay payload. */
  async function attestAndCapture(modelId) {
    const tx = await gateway.attestModel(modelId);
    const rc = await tx.wait();
    const parsed = rc.logs
      .map((entry) => {
        try {
          return gateway.interface.parseLog(entry);
        } catch {
          return null;
        }
      })
      .find((entry) => entry && entry.name === "ModelAttested");

    return {
      nonce: parsed.args.nonce,
      modelId: parsed.args.modelId,
      provider: parsed.args.provider,
      listable: parsed.args.listable,
      highRisk: parsed.args.highRisk,
      attestedAt: parsed.args.attestedAt
    };
  }

  async function relay(payload, signer = relayer) {
    return receiver
      .connect(signer)
      .receiveAttestation(
        payload.nonce,
        payload.modelId,
        payload.provider,
        payload.listable,
        payload.highRisk,
        payload.attestedAt
      );
  }

  // ------------------------------------------------------------------ gateway

  describe("RegistryGateway", function () {
    it("stores the registry and grants launch roles", async function () {
      expect(await gateway.MODEL_REGISTRY()).to.equal(await registry.getAddress());
      expect(await gateway.hasRole(await gateway.ATTESTOR_ROLE(), admin.address)).to.equal(true);
    });

    it("reverts on a zero admin or registry", async function () {
      const G = await ethers.getContractFactory("RegistryGateway");
      await expect(
        G.deploy(ethers.ZeroAddress, await registry.getAddress())
      ).to.be.revertedWithCustomError(G, "ZeroAddress");
      await expect(G.deploy(admin.address, ethers.ZeroAddress)).to.be.revertedWithCustomError(
        G,
        "ZeroAddress"
      );
    });

    it("emits an attestation carrying live registry state", async function () {
      await expect(gateway.attestModel(1))
        .to.emit(gateway, "ModelAttested")
        .withArgs(1, 1, provider.address, true, false, (v) => v > 0);
    });

    it("assigns strictly increasing nonces", async function () {
      await gateway.attestModel(1);
      expect(await gateway.nonce()).to.equal(1);
      await gateway.attestModel(1);
      expect(await gateway.nonce()).to.equal(2);
      expect(await gateway.lastAttestedNonce(1)).to.equal(2);
    });

    it("reflects a suspension in a later attestation", async function () {
      const first = await attestAndCapture(1);
      expect(first.listable).to.equal(true);

      await registry.connect(admin).suspendModel(1);
      const second = await attestAndCapture(1);
      expect(second.listable).to.equal(false);
    });

    it("reflects a provider losing its bond", async function () {
      await bond.setBonded(provider.address, false);
      const payload = await attestAndCapture(1);
      expect(payload.listable).to.equal(false);
    });

    it("carries the high-risk tier", async function () {
      await registry.connect(other).registerModel(CID, HIGH_RISK);
      const payload = await attestAndCapture(2);
      expect(payload.highRisk).to.equal(true);
    });

    it("rejects a non-attestor", async function () {
      await expect(gateway.connect(outsider).attestModel(1)).to.be.revertedWithCustomError(
        gateway,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("reverts for a model that does not exist", async function () {
      await expect(gateway.attestModel(99)).to.be.revertedWithCustomError(registry, "ModelNotFound");
    });

    it("tracks whether a model has been attested", async function () {
      expect(await gateway.hasBeenAttested(1)).to.equal(false);
      await gateway.attestModel(1);
      expect(await gateway.hasBeenAttested(1)).to.equal(true);
    });

    it("rejects a registry reporting a zero provider", async function () {
      // Unreachable through the real ModelRegistry, which reverts ModelNotFound before it
      // could ever return address(0). The mock returns zero for unset models, which is what
      // a misconfigured or malicious registry would look like. The guard is defence in
      // depth against the gateway being pointed at one.
      const Mock = await ethers.getContractFactory("MockModelRegistry");
      const mock = await Mock.deploy();
      await mock.waitForDeployment();

      const Gateway = await ethers.getContractFactory("RegistryGateway");
      const g = await Gateway.deploy(admin.address, await mock.getAddress());
      await g.waitForDeployment();

      await expect(g.attestModel(1)).to.be.revertedWithCustomError(g, "ModelHasNoProvider");
    });
  });

  // ------------------------------------------------------------------ receiver

  describe("RegistryReceiver", function () {
    it("grants admin and relayer roles separately", async function () {
      expect(await receiver.hasRole(await receiver.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
      expect(await receiver.hasRole(await receiver.RELAYER_ROLE(), relayer.address)).to.equal(true);
      expect(await receiver.hasRole(await receiver.RELAYER_ROLE(), admin.address)).to.equal(false);
    });

    it("reverts on a zero admin or relayer", async function () {
      const R = await ethers.getContractFactory("RegistryReceiver");
      await expect(R.deploy(ethers.ZeroAddress, relayer.address)).to.be.revertedWithCustomError(R, "ZeroAddress");
      await expect(R.deploy(admin.address, ethers.ZeroAddress)).to.be.revertedWithCustomError(R, "ZeroAddress");
    });

    it("rejects delivery from a non-relayer", async function () {
      const payload = await attestAndCapture(1);
      await expect(relay(payload, outsider)).to.be.revertedWithCustomError(
        receiver,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("rejects a zero nonce", async function () {
      await expect(
        receiver.connect(relayer).receiveAttestation(0, 1, provider.address, true, false, 1000)
      ).to.be.revertedWithCustomError(receiver, "ZeroNonce");
    });

    it("rejects a zero provider", async function () {
      await expect(
        receiver.connect(relayer).receiveAttestation(1, 1, ethers.ZeroAddress, true, false, 1000)
      ).to.be.revertedWithCustomError(receiver, "ZeroProvider");
    });

    it("rejects a replayed nonce", async function () {
      const payload = await attestAndCapture(1);
      await relay(payload);
      await expect(relay(payload)).to.be.revertedWithCustomError(receiver, "NonceAlreadyConsumed");
    });

    it("accepts nonces out of order, with no head-of-line blocking", async function () {
      await registry.connect(other).registerModel(CID, MINIMAL);
      const first = await attestAndCapture(1);
      const second = await attestAndCapture(2);

      // Deliver nonce 2 before nonce 1.
      await relay(second);
      await relay(first);

      expect(await receiver.consumed(first.nonce)).to.equal(true);
      expect(await receiver.consumed(second.nonce)).to.equal(true);
      expect(await receiver.mirroredCount()).to.equal(2);
    });

    it("tracks the highest nonce for sync-lag measurement", async function () {
      await registry.connect(other).registerModel(CID, MINIMAL);
      const first = await attestAndCapture(1);
      const second = await attestAndCapture(2);

      await relay(second);
      expect(await receiver.highestNonce()).to.equal(2);

      // A late lower nonce must not lower the high-water mark.
      await relay(first);
      expect(await receiver.highestNonce()).to.equal(2);
    });

    it("rejects a stale attestation that would move the mirror backwards", async function () {
      const first = await attestAndCapture(1);
      await time.increase(100);
      await registry.connect(admin).suspendModel(1);
      const second = await attestAndCapture(1);

      // Newer payload lands first.
      await relay(second);
      expect(await receiver.isMirroredListable(1)).to.equal(false);

      // The older one is refused rather than overwriting fresher state.
      await expect(relay(first)).to.be.revertedWithCustomError(receiver, "StaleAttestation");
      expect(await receiver.isMirroredListable(1)).to.equal(false);
    });

    it("permits an update carrying the same source timestamp", async function () {
      const payload = await attestAndCapture(1);
      await relay(payload);

      // Same timestamp, fresh nonce: allowed, since only strictly older is rejected.
      const resent = { ...payload, nonce: 99n, listable: false };
      await relay(resent);
      expect(await receiver.isMirroredListable(1)).to.equal(false);
    });

    it("counts each model once across repeated updates", async function () {
      const first = await attestAndCapture(1);
      await relay(first);
      expect(await receiver.mirroredCount()).to.equal(1);

      await time.increase(10);
      const second = await attestAndCapture(1);
      await relay(second);
      expect(await receiver.mirroredCount()).to.equal(1);
    });

    it("reports false listability for an unmirrored model", async function () {
      expect(await receiver.isMirroredListable(99)).to.equal(false);
    });

    it("reverts reading an unmirrored model", async function () {
      await expect(receiver.getMirroredModel(99)).to.be.revertedWithCustomError(
        receiver,
        "ModelNotMirrored"
      );
      await expect(receiver.syncLatency(99)).to.be.revertedWithCustomError(
        receiver,
        "ModelNotMirrored"
      );
    });

    it("reports sync latency", async function () {
      const payload = await attestAndCapture(1);
      await time.increase(45);
      await relay(payload);
      expect(await receiver.syncLatency(1)).to.be.greaterThanOrEqual(45);
    });

    it("returns zero latency rather than underflowing on clock skew", async function () {
      // Simulates a destination chain whose clock runs behind the source.
      const future = (await time.latest()) + 10_000;
      await receiver.connect(relayer).receiveAttestation(1, 1, provider.address, true, false, future);
      expect(await receiver.syncLatency(1)).to.equal(0);
    });
  });

  // ------------------------------------------------------------------ round trip

  describe("end-to-end relay", function () {
    it("mirrors a model registered on the source chain", async function () {
      const payload = await attestAndCapture(1);
      await expect(relay(payload)).to.emit(receiver, "AttestationReceived");

      const mirrored = await receiver.getMirroredModel(1);
      expect(mirrored.provider).to.equal(provider.address);
      expect(mirrored.listable).to.equal(true);
      expect(mirrored.highRisk).to.equal(false);
      expect(mirrored.nonce).to.equal(payload.nonce);
      expect(await receiver.isMirroredListable(1)).to.equal(true);
    });

    it("propagates a suspension across chains", async function () {
      await relay(await attestAndCapture(1));
      expect(await receiver.isMirroredListable(1)).to.equal(true);

      await time.increase(10);
      await registry.connect(admin).suspendModel(1);
      await relay(await attestAndCapture(1));

      expect(await receiver.isMirroredListable(1)).to.equal(false);
      // Source and mirror now agree.
      expect(await registry.isListable(1)).to.equal(false);
    });

    it("propagates a bond loss across chains", async function () {
      await relay(await attestAndCapture(1));
      expect(await receiver.isMirroredListable(1)).to.equal(true);

      await time.increase(10);
      await bond.setBonded(provider.address, false);
      await relay(await attestAndCapture(1));

      expect(await receiver.isMirroredListable(1)).to.equal(false);
    });

    it("mirrors several models and reports a complete sync", async function () {
      await registry.connect(other).registerModel(CID, HIGH_RISK);
      await relay(await attestAndCapture(1));
      await relay(await attestAndCapture(2));

      expect(await receiver.mirroredCount()).to.equal(2);
      expect(await receiver.highestNonce()).to.equal(await gateway.nonce());
      expect((await receiver.getMirroredModel(2)).highRisk).to.equal(true);
    });

    it("shows sync lag when a message has not been relayed", async function () {
      await registry.connect(other).registerModel(CID, MINIMAL);
      await relay(await attestAndCapture(1));
      await gateway.attestModel(2); // emitted but never relayed

      // Gateway is ahead of the receiver: this is the monitoring signal.
      expect(await gateway.nonce()).to.equal(2);
      expect(await receiver.highestNonce()).to.equal(1);
      expect(await receiver.mirroredCount()).to.equal(1);
    });

    it("keeps the receiver powerless: it holds no role on source contracts", async function () {
      const addr = await receiver.getAddress();
      expect(await registry.hasRole(await registry.CURATOR_ROLE(), addr)).to.equal(false);
      expect(await registry.hasRole(await registry.GOVERNOR_ROLE(), addr)).to.equal(false);
      expect(await registry.hasRole(await registry.DEFAULT_ADMIN_ROLE(), addr)).to.equal(false);
    });

    it("keeps a compromised relayer contained to mirror state", async function () {
      // A relayer can publish a false entry.
      await receiver.connect(relayer).receiveAttestation(1, 42, outsider.address, true, false, 1000);
      expect(await receiver.isMirroredListable(42)).to.equal(true);

      // The source chain is unaffected: model 42 does not exist there.
      await expect(registry.getModel(42)).to.be.revertedWithCustomError(registry, "ModelNotFound");
      expect(await registry.isListable(42)).to.equal(false);
    });
  });
});
