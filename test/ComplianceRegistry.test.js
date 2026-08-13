const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 60 * 60;
const HASH = ethers.keccak256(ethers.toUtf8Bytes("evidence-bundle-v1"));
const SALT = ethers.keccak256(ethers.toUtf8Bytes("salt-1"));

describe("ComplianceRegistry", function () {
  let registry;
  let admin, attestor, enterprise, provider, outsider;

  beforeEach(async function () {
    [admin, attestor, enterprise, provider, outsider] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("ComplianceRegistry");
    registry = await Registry.deploy(admin.address);
    await registry.waitForDeployment();

    await registry.grantRole(await registry.ATTESTOR_ROLE(), attestor.address);
  });

  describe("constructor", function () {
    it("grants admin and attestor roles to the deployer's admin", async function () {
      expect(await registry.hasRole(await registry.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
      expect(await registry.hasRole(await registry.ATTESTOR_ROLE(), admin.address)).to.equal(true);
    });

    it("reverts on a zero admin", async function () {
      const Registry = await ethers.getContractFactory("ComplianceRegistry");
      await expect(Registry.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        Registry,
        "ZeroAddress"
      );
    });
  });

  describe("grantAttestation", function () {
    it("records the attestation and emits", async function () {
      await expect(
        registry.connect(attestor).grantAttestation(enterprise.address, HASH, 365 * DAY)
      ).to.emit(registry, "AttestationGranted");

      const a = await registry.attestations(enterprise.address);
      expect(a.documentHash).to.equal(HASH);
      expect(a.revoked).to.equal(false);
      expect(a.expiresAt).to.equal(a.issuedAt + BigInt(365 * DAY));
    });

    it("makes the entity compliant", async function () {
      await registry.connect(attestor).grantAttestation(enterprise.address, HASH, 365 * DAY);
      expect(await registry.isCompliant(enterprise.address)).to.equal(true);
    });

    it("overwrites an existing attestation, which is how renewal works", async function () {
      await registry.connect(attestor).grantAttestation(enterprise.address, HASH, 10 * DAY);
      const first = await registry.attestations(enterprise.address);

      await time.increase(DAY);
      const newHash = ethers.keccak256(ethers.toUtf8Bytes("evidence-bundle-v2"));
      await registry.connect(attestor).grantAttestation(enterprise.address, newHash, 365 * DAY);

      const second = await registry.attestations(enterprise.address);
      expect(second.documentHash).to.equal(newHash);
      expect(second.expiresAt).to.be.greaterThan(first.expiresAt);
    });

    it("clears a prior revocation on renewal", async function () {
      await registry.connect(attestor).grantAttestation(enterprise.address, HASH, 365 * DAY);
      await registry.connect(attestor).revokeAttestation(enterprise.address);
      expect(await registry.isCompliant(enterprise.address)).to.equal(false);

      await registry.connect(attestor).grantAttestation(enterprise.address, HASH, 365 * DAY);
      expect(await registry.isCompliant(enterprise.address)).to.equal(true);
    });

    it("rejects a non-attestor", async function () {
      await expect(
        registry.connect(outsider).grantAttestation(enterprise.address, HASH, DAY)
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });

    it("reverts on a zero entity", async function () {
      await expect(
        registry.connect(attestor).grantAttestation(ethers.ZeroAddress, HASH, DAY)
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("reverts on an empty document hash", async function () {
      await expect(
        registry.connect(attestor).grantAttestation(enterprise.address, ethers.ZeroHash, DAY)
      ).to.be.revertedWithCustomError(registry, "EmptyDocumentHash");
    });

    it("reverts on a zero validity period", async function () {
      await expect(
        registry.connect(attestor).grantAttestation(enterprise.address, HASH, 0)
      ).to.be.revertedWithCustomError(registry, "ZeroValidityPeriod");
    });

    it("reverts when validity exceeds the cap", async function () {
      await expect(
        registry.connect(attestor).grantAttestation(enterprise.address, HASH, 731 * DAY)
      ).to.be.revertedWithCustomError(registry, "ValidityPeriodTooLong");
    });

    it("accepts validity exactly at the cap", async function () {
      await registry.connect(attestor).grantAttestation(enterprise.address, HASH, 730 * DAY);
      expect(await registry.isCompliant(enterprise.address)).to.equal(true);
    });
  });

  describe("expiry", function () {
    beforeEach(async function () {
      await registry.connect(attestor).grantAttestation(enterprise.address, HASH, 30 * DAY);
    });

    it("remains compliant immediately before expiry", async function () {
      await time.increase(30 * DAY - 10);
      expect(await registry.isCompliant(enterprise.address)).to.equal(true);
    });

    it("becomes non-compliant after expiry", async function () {
      await time.increase(30 * DAY + 1);
      expect(await registry.isCompliant(enterprise.address)).to.equal(false);
    });

    it("reports time remaining before expiry", async function () {
      const remaining = await registry.timeUntilExpiry(enterprise.address);
      expect(remaining).to.be.greaterThan(29 * DAY);
      expect(remaining).to.be.lessThanOrEqual(30 * DAY);
    });

    it("reports zero remaining once expired", async function () {
      await time.increase(30 * DAY + 1);
      expect(await registry.timeUntilExpiry(enterprise.address)).to.equal(0);
    });

    it("reports zero remaining when revoked", async function () {
      await registry.connect(attestor).revokeAttestation(enterprise.address);
      expect(await registry.timeUntilExpiry(enterprise.address)).to.equal(0);
    });

    it("reports zero remaining for an entity with no attestation", async function () {
      expect(await registry.timeUntilExpiry(outsider.address)).to.equal(0);
    });
  });

  describe("revokeAttestation", function () {
    beforeEach(async function () {
      await registry.connect(attestor).grantAttestation(enterprise.address, HASH, 365 * DAY);
    });

    it("marks the record without deleting it, preserving the audit trail", async function () {
      await expect(registry.connect(attestor).revokeAttestation(enterprise.address)).to.emit(
        registry,
        "AttestationRevoked"
      );

      const a = await registry.attestations(enterprise.address);
      expect(a.revoked).to.equal(true);
      expect(a.documentHash).to.equal(HASH);
      expect(a.issuedAt).to.be.greaterThan(0);
    });

    it("makes the entity non-compliant", async function () {
      await registry.connect(attestor).revokeAttestation(enterprise.address);
      expect(await registry.isCompliant(enterprise.address)).to.equal(false);
    });

    it("reverts on a double revocation", async function () {
      await registry.connect(attestor).revokeAttestation(enterprise.address);
      await expect(
        registry.connect(attestor).revokeAttestation(enterprise.address)
      ).to.be.revertedWithCustomError(registry, "AlreadyRevoked");
    });

    it("reverts when no attestation exists", async function () {
      await expect(
        registry.connect(attestor).revokeAttestation(outsider.address)
      ).to.be.revertedWithCustomError(registry, "NoAttestation");
    });

    it("rejects a non-attestor", async function () {
      await expect(
        registry.connect(outsider).revokeAttestation(enterprise.address)
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });
  });

  describe("isCompliant", function () {
    it("is false for an entity that was never attested", async function () {
      expect(await registry.isCompliant(outsider.address)).to.equal(false);
    });
  });

  describe("selective disclosure", function () {
    let commitment;

    beforeEach(async function () {
      commitment = await registry.computeCommitment(1, enterprise.address, SALT);
    });

    it("computes a commitment deterministically", async function () {
      expect(await registry.computeCommitment(1, enterprise.address, SALT)).to.equal(commitment);
    });

    it("produces different commitments for different grantees", async function () {
      const other = await registry.computeCommitment(1, outsider.address, SALT);
      expect(other).to.not.equal(commitment);
    });

    it("produces different commitments for different salts", async function () {
      const otherSalt = ethers.keccak256(ethers.toUtf8Bytes("salt-2"));
      const other = await registry.computeCommitment(1, enterprise.address, otherSalt);
      expect(other).to.not.equal(commitment);
    });

    it("records a grant and emits only the digest", async function () {
      await expect(registry.connect(provider).grantDisclosure(commitment))
        .to.emit(registry, "DisclosureGranted")
        .withArgs(commitment, provider.address);

      expect(await registry.disclosureGrants(commitment)).to.equal(true);
    });

    it("verifies a grant from its preimage", async function () {
      await registry.connect(provider).grantDisclosure(commitment);
      expect(await registry.verifyDisclosure(1, enterprise.address, SALT)).to.equal(true);
    });

    it("does not verify without the correct preimage", async function () {
      await registry.connect(provider).grantDisclosure(commitment);
      expect(await registry.verifyDisclosure(1, outsider.address, SALT)).to.equal(false);
      expect(await registry.verifyDisclosure(2, enterprise.address, SALT)).to.equal(false);
    });

    it("reverts on an empty commitment", async function () {
      await expect(
        registry.connect(provider).grantDisclosure(ethers.ZeroHash)
      ).to.be.revertedWithCustomError(registry, "EmptyCommitment");
    });

    it("reverts on a duplicate grant", async function () {
      await registry.connect(provider).grantDisclosure(commitment);
      await expect(
        registry.connect(provider).grantDisclosure(commitment)
      ).to.be.revertedWithCustomError(registry, "GrantAlreadyExists");
    });

    it("revokes a grant", async function () {
      await registry.connect(provider).grantDisclosure(commitment);
      await expect(registry.connect(provider).revokeDisclosure(commitment)).to.emit(
        registry,
        "DisclosureRevoked"
      );

      expect(await registry.verifyDisclosure(1, enterprise.address, SALT)).to.equal(false);
    });

    it("reverts when revoking a grant that does not exist", async function () {
      await expect(
        registry.connect(provider).revokeDisclosure(commitment)
      ).to.be.revertedWithCustomError(registry, "GrantNotFound");
    });

    it("allows re-granting after revocation", async function () {
      await registry.connect(provider).grantDisclosure(commitment);
      await registry.connect(provider).revokeDisclosure(commitment);
      await registry.connect(provider).grantDisclosure(commitment);
      expect(await registry.verifyDisclosure(1, enterprise.address, SALT)).to.equal(true);
    });
  });
});
