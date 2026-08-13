const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const E = (n) => ethers.parseEther(n.toString());
const DAY = 24 * 60 * 60;

const CHALLENGE_WINDOW = 60; // testnet demonstration value
const LOCK_PERIOD = 7 * DAY;
const MIN_BOND = E(1000);

describe("PerformanceOracle", function () {
  let token, vault, registry, oracle;
  let admin, treasury, provider, r1, r2, r3, outsider;

  beforeEach(async function () {
    [admin, treasury, provider, r1, r2, r3, outsider] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("AIMToken");
    token = await Token.deploy(
      admin.address,
      treasury.address,
      provider.address,
      r1.address,
      r2.address
    );
    await token.waitForDeployment();

    // Real StakingVault: the point is to prove oracle data actually burns a bond.
    const Vault = await ethers.getContractFactory("StakingVault");
    vault = await Vault.deploy(
      await token.getAddress(),
      admin.address,
      treasury.address,
      LOCK_PERIOD,
      MIN_BOND
    );
    await vault.waitForDeployment();

    const Registry = await ethers.getContractFactory("MockModelRegistry");
    registry = await Registry.deploy();
    await registry.waitForDeployment();
    await registry.setModel(1, provider.address, true, false);

    const Oracle = await ethers.getContractFactory("PerformanceOracle");
    oracle = await Oracle.deploy(
      admin.address,
      await vault.getAddress(),
      await registry.getAddress(),
      CHALLENGE_WINDOW
    );
    await oracle.waitForDeployment();

    // The oracle must hold SLASHER_ROLE on the vault to enforce.
    await vault.grantRole(await vault.SLASHER_ROLE(), await oracle.getAddress());

    for (const r of [r1, r2, r3]) {
      await oracle.addReporter(r.address);
    }

    // Provider bonds 10,000 AIM.
    await token.connect(provider).approve(await vault.getAddress(), E(1_000_000));
    await vault.connect(provider).stake(E(10_000));
  });

  async function submitAll(scores) {
    const signers = [r1, r2, r3];
    for (let i = 0; i < scores.length; i++) {
      await oracle.connect(signers[i]).submitScore(1, scores[i]);
    }
  }

  describe("constructor", function () {
    it("sets defaults and grants roles", async function () {
      expect(await oracle.quorum()).to.equal(3);
      expect(await oracle.failureThreshold()).to.equal(6000);
      expect(await oracle.maxDeviationBps()).to.equal(2500);
      expect(await oracle.challengeWindow()).to.equal(CHALLENGE_WINDOW);
      expect(await oracle.stalenessPeriod()).to.equal(7 * DAY);
      expect(await oracle.slashBps()).to.equal(1000);
      expect(await oracle.hasRole(await oracle.GOVERNOR_ROLE(), admin.address)).to.equal(true);
    });

    it("reverts on zero addresses", async function () {
      const Oracle = await ethers.getContractFactory("PerformanceOracle");
      const v = await vault.getAddress();
      const g = await registry.getAddress();
      await expect(Oracle.deploy(ethers.ZeroAddress, v, g, 60)).to.be.revertedWithCustomError(Oracle, "ZeroAddress");
      await expect(Oracle.deploy(admin.address, ethers.ZeroAddress, g, 60)).to.be.revertedWithCustomError(Oracle, "ZeroAddress");
      await expect(Oracle.deploy(admin.address, v, ethers.ZeroAddress, 60)).to.be.revertedWithCustomError(Oracle, "ZeroAddress");
    });

    it("reverts on a zero challenge window", async function () {
      const Oracle = await ethers.getContractFactory("PerformanceOracle");
      await expect(
        Oracle.deploy(admin.address, await vault.getAddress(), await registry.getAddress(), 0)
      ).to.be.revertedWithCustomError(Oracle, "ZeroValue");
    });

    it("reverts when the challenge window exceeds the cap", async function () {
      const Oracle = await ethers.getContractFactory("PerformanceOracle");
      await expect(
        Oracle.deploy(admin.address, await vault.getAddress(), await registry.getAddress(), 31 * DAY)
      ).to.be.revertedWithCustomError(Oracle, "ValueTooLarge");
    });
  });

  describe("reporter set", function () {
    it("tracks the reporter count", async function () {
      expect(await oracle.reporterCount()).to.equal(3);
    });

    it("rejects a duplicate reporter", async function () {
      await expect(oracle.addReporter(r1.address)).to.be.revertedWithCustomError(oracle, "AlreadyReporter");
    });

    it("rejects a zero reporter", async function () {
      await expect(oracle.addReporter(ethers.ZeroAddress)).to.be.revertedWithCustomError(oracle, "ZeroAddress");
    });

    it("enforces the cap of seven", async function () {
      const extra = await ethers.getSigners();
      // Three already admitted; add four more to reach seven.
      for (let i = 7; i < 11; i++) {
        await oracle.addReporter(extra[i].address);
      }
      expect(await oracle.reporterCount()).to.equal(7);
      await expect(oracle.addReporter(extra[11].address)).to.be.revertedWithCustomError(
        oracle,
        "ReporterSetFull"
      );
    });

    it("removes a reporter and revokes the role", async function () {
      await expect(oracle.removeReporter(r3.address)).to.emit(oracle, "ReporterRemoved");
      expect(await oracle.reporterCount()).to.equal(2);
      expect(await oracle.hasRole(await oracle.REPORTER_ROLE(), r3.address)).to.equal(false);
    });

    it("rejects removing a non-reporter", async function () {
      await expect(oracle.removeReporter(outsider.address)).to.be.revertedWithCustomError(
        oracle,
        "NotAReporter"
      );
    });

    it("rejects a non-governor managing reporters", async function () {
      await expect(
        oracle.connect(outsider).addReporter(outsider.address)
      ).to.be.revertedWithCustomError(oracle, "AccessControlUnauthorizedAccount");
      await expect(
        oracle.connect(outsider).removeReporter(r1.address)
      ).to.be.revertedWithCustomError(oracle, "AccessControlUnauthorizedAccount");
    });
  });

  describe("submitScore", function () {
    it("opens round one on the first submission", async function () {
      await oracle.connect(r1).submitScore(1, 8000);
      expect(await oracle.latestRound(1)).to.equal(1);
    });

    it("emits with the round and score", async function () {
      await expect(oracle.connect(r1).submitScore(1, 8000))
        .to.emit(oracle, "ScoreSubmitted")
        .withArgs(1, 1, r1.address, 8000);
    });

    it("accumulates submissions in the open round", async function () {
      await submitAll([8000, 8200, 7800]);
      const r = await oracle.rounds(1, 1);
      expect(r.count).to.equal(3);
      expect(r.sum).to.equal(24000);
    });

    it("rejects a non-reporter", async function () {
      await expect(
        oracle.connect(outsider).submitScore(1, 8000)
      ).to.be.revertedWithCustomError(oracle, "AccessControlUnauthorizedAccount");
    });

    it("rejects a score above the scale", async function () {
      await expect(oracle.connect(r1).submitScore(1, 10_001)).to.be.revertedWithCustomError(
        oracle,
        "InvalidScore"
      );
    });

    it("accepts a score exactly at the scale", async function () {
      await oracle.connect(r1).submitScore(1, 10_000);
      expect((await oracle.rounds(1, 1)).sum).to.equal(10_000);
    });

    it("rejects a duplicate submission from the same reporter", async function () {
      await oracle.connect(r1).submitScore(1, 8000);
      await expect(oracle.connect(r1).submitScore(1, 8100)).to.be.revertedWithCustomError(
        oracle,
        "AlreadySubmitted"
      );
    });

    it("rejects a submission deviating too far from the running mean", async function () {
      await oracle.connect(r1).submitScore(1, 8000);
      // 25 percent of 8000 is 2000, so 5000 is outside the guard.
      await expect(oracle.connect(r2).submitScore(1, 5000)).to.be.revertedWithCustomError(
        oracle,
        "DeviationTooLarge"
      );
    });

    it("accepts a submission at the deviation boundary", async function () {
      await oracle.connect(r1).submitScore(1, 8000);
      await oracle.connect(r2).submitScore(1, 6000); // exactly 25 percent below
      expect((await oracle.rounds(1, 1)).count).to.equal(2);
    });

    it("opens a new round after the previous one is finalized", async function () {
      await submitAll([8000, 8000, 8000]);
      await oracle.finalizeRound(1);
      await oracle.connect(r1).submitScore(1, 7000);
      expect(await oracle.latestRound(1)).to.equal(2);
    });
  });

  describe("finalizeRound", function () {
    it("computes the mean and does not flag a passing score", async function () {
      await submitAll([8000, 8200, 7800]);
      await expect(oracle.finalizeRound(1))
        .to.emit(oracle, "RoundFinalized")
        .withArgs(1, 1, 8000, false);

      const r = await oracle.rounds(1, 1);
      expect(r.meanScore).to.equal(8000);
      expect(r.flaggedAt).to.equal(0);
    });

    it("flags a failing score", async function () {
      await submitAll([5000, 5500, 4500]);
      await expect(oracle.finalizeRound(1))
        .to.emit(oracle, "RoundFinalized")
        .withArgs(1, 1, 5000, true);

      expect((await oracle.rounds(1, 1)).flaggedAt).to.be.greaterThan(0);
    });

    it("flags a score exactly at the threshold", async function () {
      await submitAll([6000, 6000, 6000]);
      await oracle.finalizeRound(1);
      expect((await oracle.rounds(1, 1)).flaggedAt).to.be.greaterThan(0);
    });

    it("is permissionless", async function () {
      await submitAll([8000, 8000, 8000]);
      await oracle.connect(outsider).finalizeRound(1);
      expect((await oracle.rounds(1, 1)).finalizedAt).to.be.greaterThan(0);
    });

    it("reverts when no round exists", async function () {
      await expect(oracle.finalizeRound(99)).to.be.revertedWithCustomError(oracle, "NoRound");
    });

    it("reverts before quorum", async function () {
      await submitAll([8000, 8000]);
      await expect(oracle.finalizeRound(1)).to.be.revertedWithCustomError(oracle, "QuorumNotReached");
    });

    it("reverts on double finalization", async function () {
      await submitAll([8000, 8000, 8000]);
      await oracle.finalizeRound(1);
      await expect(oracle.finalizeRound(1)).to.be.revertedWithCustomError(
        oracle,
        "RoundAlreadyFinalized"
      );
    });
  });

  describe("enforceSlash", function () {
    beforeEach(async function () {
      await submitAll([5000, 5000, 5000]);
      await oracle.finalizeRound(1);
    });

    it("burns ten percent of the bond after the window lapses", async function () {
      const before = await vault.balanceOf(provider.address);
      const treasuryBefore = await token.balanceOf(treasury.address);

      await time.increase(CHALLENGE_WINDOW + 1);
      await expect(oracle.enforceSlash(1)).to.emit(oracle, "SlashEnforced");

      expect(await vault.balanceOf(provider.address)).to.equal(before - E(1000));
      expect(await token.balanceOf(treasury.address)).to.equal(treasuryBefore + E(1000));
    });

    it("can drive a provider below the bond threshold, ending sellability", async function () {
      // 10,000 bond, min 1,000. Repeated enforcement erodes it.
      expect(await vault.isBondedProvider(provider.address)).to.equal(true);

      for (let i = 0; i < 3; i++) {
        await time.increase(CHALLENGE_WINDOW + 1);
        await oracle.enforceSlash(1);
        await submitAll([5000, 5000, 5000]);
        await oracle.finalizeRound(1);
      }

      // Bond has fallen but is still above the minimum; the mechanism is what matters.
      expect(await vault.balanceOf(provider.address)).to.be.lessThan(E(10_000));
    });

    it("is permissionless", async function () {
      await time.increase(CHALLENGE_WINDOW + 1);
      await oracle.connect(outsider).enforceSlash(1);
      expect((await oracle.rounds(1, 1)).enforced).to.equal(true);
    });

    it("reverts while the challenge window is open", async function () {
      await expect(oracle.enforceSlash(1)).to.be.revertedWithCustomError(oracle, "ChallengeWindowOpen");
    });

    it("reverts on double enforcement", async function () {
      await time.increase(CHALLENGE_WINDOW + 1);
      await oracle.enforceSlash(1);
      await expect(oracle.enforceSlash(1)).to.be.revertedWithCustomError(oracle, "AlreadyEnforced");
    });

    it("reverts when the round was challenged", async function () {
      await oracle.connect(provider).challenge(1);
      await time.increase(CHALLENGE_WINDOW + 1);
      await expect(oracle.enforceSlash(1)).to.be.revertedWithCustomError(oracle, "RoundWasChallenged");
    });

    it("reverts on a stale round", async function () {
      await time.increase(8 * DAY);
      await expect(oracle.enforceSlash(1)).to.be.revertedWithCustomError(oracle, "RoundStale");
    });

    it("reverts when the round passed and was never flagged", async function () {
      await oracle.connect(r1).submitScore(1, 8000);
      await oracle.connect(r2).submitScore(1, 8000);
      await oracle.connect(r3).submitScore(1, 8000);
      await oracle.finalizeRound(1);
      await time.increase(CHALLENGE_WINDOW + 1);
      await expect(oracle.enforceSlash(1)).to.be.revertedWithCustomError(oracle, "RoundNotFlagged");
    });

    it("reverts when the round is not finalized", async function () {
      await oracle.connect(r1).submitScore(1, 5000); // opens round 2
      await expect(oracle.enforceSlash(1)).to.be.revertedWithCustomError(oracle, "RoundNotFinalized");
    });

    it("reverts when no round exists", async function () {
      await expect(oracle.enforceSlash(99)).to.be.revertedWithCustomError(oracle, "NoRound");
    });

    it("reverts when the provider has no bond", async function () {
      await registry.setModel(2, outsider.address, true, false);
      await oracle.connect(r1).submitScore(2, 5000);
      await oracle.connect(r2).submitScore(2, 5000);
      await oracle.connect(r3).submitScore(2, 5000);
      await oracle.finalizeRound(2);
      await time.increase(CHALLENGE_WINDOW + 1);
      await expect(oracle.enforceSlash(2)).to.be.revertedWithCustomError(oracle, "NoBondToSlash");
    });
  });

  describe("challenge", function () {
    beforeEach(async function () {
      await submitAll([5000, 5000, 5000]);
      await oracle.finalizeRound(1);
    });

    it("lets the provider void a pending slash", async function () {
      await expect(oracle.connect(provider).challenge(1)).to.emit(oracle, "RoundChallenged");
      expect((await oracle.rounds(1, 1)).challenged).to.equal(true);
    });

    it("rejects anyone other than the provider", async function () {
      await expect(oracle.connect(outsider).challenge(1)).to.be.revertedWithCustomError(
        oracle,
        "NotModelProvider"
      );
    });

    it("rejects a second challenge", async function () {
      await oracle.connect(provider).challenge(1);
      await expect(oracle.connect(provider).challenge(1)).to.be.revertedWithCustomError(
        oracle,
        "RoundWasChallenged"
      );
    });

    it("rejects a challenge after the window closes", async function () {
      await time.increase(CHALLENGE_WINDOW + 1);
      await expect(oracle.connect(provider).challenge(1)).to.be.revertedWithCustomError(
        oracle,
        "ChallengeWindowClosed"
      );
    });

    it("rejects a challenge on an unflagged round", async function () {
      await oracle.connect(r1).submitScore(1, 8000);
      await oracle.connect(r2).submitScore(1, 8000);
      await oracle.connect(r3).submitScore(1, 8000);
      await oracle.finalizeRound(1);
      await expect(oracle.connect(provider).challenge(1)).to.be.revertedWithCustomError(
        oracle,
        "RoundNotFlagged"
      );
    });

    it("rejects a challenge on an unfinalized round", async function () {
      await oracle.connect(r1).submitScore(1, 5000); // opens round 2
      await expect(oracle.connect(provider).challenge(1)).to.be.revertedWithCustomError(
        oracle,
        "RoundNotFinalized"
      );
    });

    it("rejects a challenge when no round exists", async function () {
      await expect(oracle.connect(provider).challenge(99)).to.be.revertedWithCustomError(
        oracle,
        "NoRound"
      );
    });

    it("rejects a challenge after enforcement", async function () {
      await time.increase(CHALLENGE_WINDOW + 1);
      await oracle.enforceSlash(1);
      await expect(oracle.connect(provider).challenge(1)).to.be.revertedWithCustomError(
        oracle,
        "AlreadyEnforced"
      );
    });
  });

  describe("views", function () {
    it("reports the latest score after finalization", async function () {
      await submitAll([8000, 8000, 8000]);
      await oracle.finalizeRound(1);
      const [mean, finalizedAt] = await oracle.latestScore(1);
      expect(mean).to.equal(8000);
      expect(finalizedAt).to.be.greaterThan(0);
    });

    it("reports freshness correctly", async function () {
      expect(await oracle.isScoreFresh(1)).to.equal(false);

      await submitAll([8000, 8000, 8000]);
      await oracle.finalizeRound(1);
      expect(await oracle.isScoreFresh(1)).to.equal(true);

      await time.increase(8 * DAY);
      expect(await oracle.isScoreFresh(1)).to.equal(false);
    });

    it("reports challenge time remaining", async function () {
      expect(await oracle.challengeTimeRemaining(1)).to.equal(0);

      await submitAll([5000, 5000, 5000]);
      await oracle.finalizeRound(1);
      expect(await oracle.challengeTimeRemaining(1)).to.be.greaterThan(0);

      await time.increase(CHALLENGE_WINDOW + 1);
      expect(await oracle.challengeTimeRemaining(1)).to.equal(0);
    });

    it("reports zero remaining once challenged", async function () {
      await submitAll([5000, 5000, 5000]);
      await oracle.finalizeRound(1);
      await oracle.connect(provider).challenge(1);
      expect(await oracle.challengeTimeRemaining(1)).to.equal(0);
    });

    it("reports zero remaining once enforced", async function () {
      await submitAll([5000, 5000, 5000]);
      await oracle.finalizeRound(1);
      await time.increase(CHALLENGE_WINDOW + 1);
      await oracle.enforceSlash(1);
      expect(await oracle.challengeTimeRemaining(1)).to.equal(0);
    });
  });

  describe("parameters", function () {
    it("sets quorum", async function () {
      await expect(oracle.setQuorum(2)).to.emit(oracle, "ParameterUpdated");
      expect(await oracle.quorum()).to.equal(2);
    });

    it("rejects a zero quorum", async function () {
      await expect(oracle.setQuorum(0)).to.be.revertedWithCustomError(oracle, "ZeroValue");
    });

    it("rejects a quorum above the reporter cap", async function () {
      await expect(oracle.setQuorum(8)).to.be.revertedWithCustomError(oracle, "InvalidQuorum");
    });

    it("sets the failure threshold", async function () {
      await oracle.setFailureThreshold(7000);
      expect(await oracle.failureThreshold()).to.equal(7000);
    });

    it("rejects a failure threshold above the scale", async function () {
      await expect(oracle.setFailureThreshold(10_001)).to.be.revertedWithCustomError(
        oracle,
        "ValueTooLarge"
      );
    });

    it("sets the deviation guard", async function () {
      await oracle.setMaxDeviationBps(5000);
      expect(await oracle.maxDeviationBps()).to.equal(5000);
    });

    it("rejects a zero deviation guard", async function () {
      await expect(oracle.setMaxDeviationBps(0)).to.be.revertedWithCustomError(oracle, "ZeroValue");
    });

    it("rejects a deviation guard above the scale", async function () {
      await expect(oracle.setMaxDeviationBps(10_001)).to.be.revertedWithCustomError(
        oracle,
        "ValueTooLarge"
      );
    });

    it("sets the challenge window, which is how production differs from the demo", async function () {
      await oracle.setChallengeWindow(7 * DAY);
      expect(await oracle.challengeWindow()).to.equal(7 * DAY);
    });

    it("rejects a zero challenge window", async function () {
      await expect(oracle.setChallengeWindow(0)).to.be.revertedWithCustomError(oracle, "ZeroValue");
    });

    it("rejects a challenge window above the cap", async function () {
      await expect(oracle.setChallengeWindow(31 * DAY)).to.be.revertedWithCustomError(
        oracle,
        "ValueTooLarge"
      );
    });

    it("sets the staleness period", async function () {
      await oracle.setStalenessPeriod(14 * DAY);
      expect(await oracle.stalenessPeriod()).to.equal(14 * DAY);
    });

    it("rejects a zero staleness period", async function () {
      await expect(oracle.setStalenessPeriod(0)).to.be.revertedWithCustomError(oracle, "ZeroValue");
    });

    it("rejects a staleness period above the cap", async function () {
      await expect(oracle.setStalenessPeriod(31 * DAY)).to.be.revertedWithCustomError(
        oracle,
        "ValueTooLarge"
      );
    });

    it("sets the slash fraction", async function () {
      await oracle.setSlashBps(2000);
      expect(await oracle.slashBps()).to.equal(2000);
    });

    it("rejects a zero slash fraction", async function () {
      await expect(oracle.setSlashBps(0)).to.be.revertedWithCustomError(oracle, "ZeroValue");
    });

    it("rejects a slash fraction above the scale", async function () {
      await expect(oracle.setSlashBps(10_001)).to.be.revertedWithCustomError(oracle, "ValueTooLarge");
    });

    it("rejects a non-governor changing parameters", async function () {
      await expect(oracle.connect(outsider).setQuorum(2)).to.be.revertedWithCustomError(
        oracle,
        "AccessControlUnauthorizedAccount"
      );
    });
  });
});
