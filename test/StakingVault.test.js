const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const E = (n) => ethers.parseEther(n.toString());
const DAY = 24 * 60 * 60;

const LOCK_PERIOD = 7 * DAY;
const MIN_BOND = E(1000);

describe("StakingVault", function () {
  let token, vault;
  let admin, treasury, funder, oracle, governor, alice, bob;

  beforeEach(async function () {
    [admin, treasury, funder, oracle, governor, alice, bob] = await ethers.getSigners();

    // admin receives the staking-rewards allocation and acts as distributor.
    const Token = await ethers.getContractFactory("AIMToken");
    token = await Token.deploy(
      admin.address,
      treasury.address,
      funder.address,
      alice.address,
      bob.address
    );
    await token.waitForDeployment();

    const Vault = await ethers.getContractFactory("StakingVault");
    vault = await Vault.deploy(
      await token.getAddress(),
      admin.address,
      treasury.address,
      LOCK_PERIOD,
      MIN_BOND
    );
    await vault.waitForDeployment();

    await vault.grantRole(await vault.GOVERNOR_ROLE(), governor.address);
    await vault.grantRole(await vault.SLASHER_ROLE(), oracle.address);
    await vault.grantRole(await vault.REWARD_FUNDER_ROLE(), funder.address);

    // Seed participants. alice and bob already hold allocations from the token deploy.
    await token.connect(admin).transfer(funder.address, E(10_000_000));
    await token.connect(alice).approve(await vault.getAddress(), E(1_000_000_000));
    await token.connect(bob).approve(await vault.getAddress(), E(1_000_000_000));
    await token.connect(funder).approve(await vault.getAddress(), E(1_000_000_000));
  });

  // ------------------------------------------------------------------ constructor

  describe("constructor", function () {
    it("stores configuration and grants launch roles", async function () {
      expect(await vault.STAKING_TOKEN()).to.equal(await token.getAddress());
      expect(await vault.treasury()).to.equal(treasury.address);
      expect(await vault.lockPeriod()).to.equal(LOCK_PERIOD);
      expect(await vault.minProviderBond()).to.equal(MIN_BOND);
      expect(await vault.hasRole(await vault.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
      expect(await vault.hasRole(await vault.PAUSER_ROLE(), admin.address)).to.equal(true);
    });

    it("reverts on a zero staking token", async function () {
      const Vault = await ethers.getContractFactory("StakingVault");
      await expect(
        Vault.deploy(ethers.ZeroAddress, admin.address, treasury.address, LOCK_PERIOD, MIN_BOND)
      ).to.be.revertedWithCustomError(Vault, "ZeroAddress");
    });

    it("reverts on a zero admin", async function () {
      const Vault = await ethers.getContractFactory("StakingVault");
      await expect(
        Vault.deploy(await token.getAddress(), ethers.ZeroAddress, treasury.address, LOCK_PERIOD, MIN_BOND)
      ).to.be.revertedWithCustomError(Vault, "ZeroAddress");
    });

    it("reverts on a zero treasury", async function () {
      const Vault = await ethers.getContractFactory("StakingVault");
      await expect(
        Vault.deploy(await token.getAddress(), admin.address, ethers.ZeroAddress, LOCK_PERIOD, MIN_BOND)
      ).to.be.revertedWithCustomError(Vault, "ZeroAddress");
    });

    it("reverts when the lock period exceeds the cap", async function () {
      const Vault = await ethers.getContractFactory("StakingVault");
      await expect(
        Vault.deploy(await token.getAddress(), admin.address, treasury.address, 366 * DAY, MIN_BOND)
      ).to.be.revertedWithCustomError(Vault, "LockPeriodTooLong");
    });
  });

  // ------------------------------------------------------------------ staking

  describe("stake", function () {
    it("credits the balance, total, lock and eligibility timestamp", async function () {
      await vault.connect(alice).stake(E(5000));
      const now = await time.latest();

      expect(await vault.balanceOf(alice.address)).to.equal(E(5000));
      expect(await vault.totalStaked()).to.equal(E(5000));
      expect(await vault.unlockAt(alice.address)).to.equal(now + LOCK_PERIOD);
      expect(await vault.lastIncreaseAt(alice.address)).to.equal(now);
    });

    it("emits Staked", async function () {
      await expect(vault.connect(alice).stake(E(100))).to.emit(vault, "Staked");
    });

    it("accumulates across multiple stakes and resets the lock", async function () {
      await vault.connect(alice).stake(E(1000));
      const firstUnlock = await vault.unlockAt(alice.address);

      await time.increase(DAY);
      await vault.connect(alice).stake(E(1000));

      expect(await vault.balanceOf(alice.address)).to.equal(E(2000));
      expect(await vault.unlockAt(alice.address)).to.be.greaterThan(firstUnlock);
    });

    it("reverts on a zero amount", async function () {
      await expect(vault.connect(alice).stake(0)).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("reverts without sufficient allowance", async function () {
      await token.connect(alice).approve(await vault.getAddress(), 0);
      await expect(
        vault.connect(alice).stake(E(1))
      ).to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance");
    });
  });

  // ------------------------------------------------------------------ withdraw

  describe("withdraw", function () {
    beforeEach(async function () {
      await vault.connect(alice).stake(E(5000));
    });

    it("reverts while the stake is locked", async function () {
      await expect(
        vault.connect(alice).withdraw(E(1000))
      ).to.be.revertedWithCustomError(vault, "StakeLocked");
    });

    it("returns tokens once unlocked", async function () {
      await time.increase(LOCK_PERIOD + 1);
      const before = await token.balanceOf(alice.address);

      await vault.connect(alice).withdraw(E(5000));

      expect(await token.balanceOf(alice.address)).to.equal(before + E(5000));
      expect(await vault.balanceOf(alice.address)).to.equal(0);
      expect(await vault.totalStaked()).to.equal(0);
    });

    it("supports a partial withdrawal", async function () {
      await time.increase(LOCK_PERIOD + 1);
      await vault.connect(alice).withdraw(E(2000));
      expect(await vault.balanceOf(alice.address)).to.equal(E(3000));
    });

    it("emits Withdrawn", async function () {
      await time.increase(LOCK_PERIOD + 1);
      await expect(vault.connect(alice).withdraw(E(1))).to.emit(vault, "Withdrawn");
    });

    it("reverts on a zero amount", async function () {
      await time.increase(LOCK_PERIOD + 1);
      await expect(vault.connect(alice).withdraw(0)).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("reverts when the amount exceeds the stake", async function () {
      await time.increase(LOCK_PERIOD + 1);
      await expect(
        vault.connect(alice).withdraw(E(5001))
      ).to.be.revertedWithCustomError(vault, "InsufficientStake");
    });
  });

  // ------------------------------------------------------------------ rewards

  describe("fundRewards", function () {
    it("pulls tokens, sets the rate and emits", async function () {
      await expect(vault.connect(funder).fundRewards(E(700), 7 * DAY)).to.emit(vault, "RewardsFunded");

      expect(await vault.rewardReserve()).to.equal(E(700));
      expect(await vault.rewardRate()).to.equal(E(700) / BigInt(7 * DAY));
    });

    it("rolls unspent rewards into a new period", async function () {
      await vault.connect(funder).fundRewards(E(700), 7 * DAY);
      await time.increase(DAY);
      await vault.connect(funder).fundRewards(E(700), 7 * DAY);

      expect(await vault.rewardReserve()).to.equal(E(1400));
      // Leftover from the first period raises the rate above a bare 700/7d.
      expect(await vault.rewardRate()).to.be.greaterThan(E(700) / BigInt(7 * DAY));
    });

    it("rejects callers without REWARD_FUNDER_ROLE", async function () {
      await expect(
        vault.connect(alice).fundRewards(E(1), DAY)
      ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
    });

    it("reverts on a zero amount", async function () {
      await expect(
        vault.connect(funder).fundRewards(0, DAY)
      ).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("reverts on a zero duration", async function () {
      await expect(
        vault.connect(funder).fundRewards(E(1), 0)
      ).to.be.revertedWithCustomError(vault, "ZeroDuration");
    });

    it("reverts when the resulting rate would round to zero", async function () {
      await expect(
        vault.connect(funder).fundRewards(1, 365 * DAY)
      ).to.be.revertedWithCustomError(vault, "RewardPeriodTooShort");
    });
  });

  describe("reward accrual", function () {
    it("accrues nothing while no one is staked", async function () {
      await vault.connect(funder).fundRewards(E(700), 7 * DAY);
      await time.increase(DAY);
      expect(await vault.rewardPerToken()).to.equal(0);
    });

    it("credits a lone staker the full emission", async function () {
      await vault.connect(alice).stake(E(1000));
      await vault.connect(funder).fundRewards(E(700), 7 * DAY);
      await time.increase(7 * DAY);

      const earned = await vault.earned(alice.address);
      expect(earned).to.be.closeTo(E(700), E(1));
    });

    it("splits emission in proportion to stake", async function () {
      await vault.connect(alice).stake(E(1000));
      await vault.connect(bob).stake(E(3000));
      await vault.connect(funder).fundRewards(E(800), 7 * DAY);
      await time.increase(7 * DAY);

      const a = await vault.earned(alice.address);
      const b = await vault.earned(bob.address);
      expect(b).to.be.closeTo(a * 3n, E(1));
    });

    it("stops accruing after the period ends", async function () {
      await vault.connect(alice).stake(E(1000));
      await vault.connect(funder).fundRewards(E(700), 7 * DAY);
      await time.increase(7 * DAY);
      const atFinish = await vault.earned(alice.address);

      await time.increase(30 * DAY);
      expect(await vault.earned(alice.address)).to.equal(atFinish);
    });
  });

  describe("getReward", function () {
    it("pays out and clears the entitlement", async function () {
      await vault.connect(alice).stake(E(1000));
      await vault.connect(funder).fundRewards(E(700), 7 * DAY);
      await time.increase(7 * DAY);

      const before = await token.balanceOf(alice.address);
      await expect(vault.connect(alice).getReward()).to.emit(vault, "RewardPaid");

      expect(await token.balanceOf(alice.address)).to.be.greaterThan(before);
      expect(await vault.rewards(alice.address)).to.equal(0);
    });

    it("is a no-op when nothing is owed", async function () {
      await expect(vault.connect(alice).getReward()).to.not.emit(vault, "RewardPaid");
    });

    it("never pays rewards out of staked principal", async function () {
      await vault.connect(alice).stake(E(1000));
      await vault.connect(funder).fundRewards(E(700), 7 * DAY);
      await time.increase(30 * DAY);
      await vault.connect(alice).getReward();

      const [held, owed] = await vault.solvency();
      expect(held).to.be.greaterThanOrEqual(owed);
      expect(await vault.totalStaked()).to.equal(E(1000));
    });
  });

  // ------------------------------------------------------------------ slashing

  describe("slash", function () {
    beforeEach(async function () {
      await vault.connect(alice).stake(E(10_000));
    });

    it("moves the slashed amount to the treasury", async function () {
      const before = await token.balanceOf(treasury.address);
      await expect(vault.connect(oracle).slash(alice.address, E(1000))).to.emit(vault, "Slashed");

      expect(await token.balanceOf(treasury.address)).to.equal(before + E(1000));
      expect(await vault.balanceOf(alice.address)).to.equal(E(9000));
      expect(await vault.totalStaked()).to.equal(E(9000));
    });

    it("permits a slash exactly at the cap", async function () {
      await vault.connect(oracle).slash(alice.address, E(5000));
      expect(await vault.balanceOf(alice.address)).to.equal(E(5000));
    });

    it("rejects a slash above the 50 percent cap", async function () {
      await expect(
        vault.connect(oracle).slash(alice.address, E(5001))
      ).to.be.revertedWithCustomError(vault, "SlashExceedsCap");
    });

    it("rejects a slash exceeding the stake", async function () {
      await expect(
        vault.connect(oracle).slash(alice.address, E(10_001))
      ).to.be.revertedWithCustomError(vault, "InsufficientStake");
    });

    it("rejects callers without SLASHER_ROLE", async function () {
      await expect(
        vault.connect(bob).slash(alice.address, E(1))
      ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
    });

    it("reverts on a zero target", async function () {
      await expect(
        vault.connect(oracle).slash(ethers.ZeroAddress, E(1))
      ).to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("reverts on a zero amount", async function () {
      await expect(
        vault.connect(oracle).slash(alice.address, 0)
      ).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("preserves accrued rewards through a slash", async function () {
      await vault.connect(funder).fundRewards(E(700), 7 * DAY);
      await time.increase(7 * DAY);
      const before = await vault.earned(alice.address);

      await vault.connect(oracle).slash(alice.address, E(1000));
      expect(await vault.earned(alice.address)).to.be.closeTo(before, E(1));
    });
  });

  // ------------------------------------------------------------------ governance hooks

  describe("votingPowerAt", function () {
    it("returns zero for an account that never staked", async function () {
      expect(await vault.votingPowerAt(alice.address, await time.latest())).to.equal(0);
    });

    it("returns the staked balance when the stake predates the snapshot", async function () {
      await vault.connect(alice).stake(E(2500));
      await time.increase(DAY);
      const snapshot = await time.latest();

      expect(await vault.votingPowerAt(alice.address, snapshot)).to.equal(E(2500));
    });

    it("returns zero when the stake was increased after the snapshot", async function () {
      const snapshot = await time.latest();
      await time.increase(DAY);
      await vault.connect(alice).stake(E(2500));

      // This is the anti-flash-loan control.
      expect(await vault.votingPowerAt(alice.address, snapshot)).to.equal(0);
    });

    it("revokes weight for the current proposal when a staker tops up", async function () {
      await vault.connect(alice).stake(E(1000));
      await time.increase(DAY);
      const snapshot = await time.latest();
      expect(await vault.votingPowerAt(alice.address, snapshot)).to.equal(E(1000));

      await vault.connect(alice).stake(E(1));
      expect(await vault.votingPowerAt(alice.address, snapshot)).to.equal(0);
    });
  });

  describe("isBondedProvider", function () {
    it("is false below the threshold", async function () {
      await vault.connect(alice).stake(MIN_BOND - 1n);
      expect(await vault.isBondedProvider(alice.address)).to.equal(false);
    });

    it("is true at or above the threshold", async function () {
      await vault.connect(alice).stake(MIN_BOND);
      expect(await vault.isBondedProvider(alice.address)).to.equal(true);
    });
  });

  describe("solvency", function () {
    it("reports holdings at least equal to obligations", async function () {
      await vault.connect(alice).stake(E(1000));
      await vault.connect(funder).fundRewards(E(700), 7 * DAY);

      const [held, owed] = await vault.solvency();
      expect(held).to.equal(E(1700));
      expect(owed).to.equal(E(1700));
    });
  });

  // ------------------------------------------------------------------ parameters

  describe("parameter control", function () {
    it("lets the governor change the lock period", async function () {
      await expect(vault.connect(governor).setLockPeriod(14 * DAY)).to.emit(vault, "LockPeriodUpdated");
      expect(await vault.lockPeriod()).to.equal(14 * DAY);
    });

    it("rejects a lock period above the cap", async function () {
      await expect(
        vault.connect(governor).setLockPeriod(366 * DAY)
      ).to.be.revertedWithCustomError(vault, "LockPeriodTooLong");
    });

    it("rejects a non-governor changing the lock period", async function () {
      await expect(
        vault.connect(alice).setLockPeriod(DAY)
      ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
    });

    it("lets the governor change the minimum bond", async function () {
      await expect(vault.connect(governor).setMinProviderBond(E(5000))).to.emit(
        vault,
        "MinProviderBondUpdated"
      );
      expect(await vault.minProviderBond()).to.equal(E(5000));
    });

    it("rejects a non-governor changing the minimum bond", async function () {
      await expect(
        vault.connect(alice).setMinProviderBond(0)
      ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
    });

    it("lets the governor change the treasury", async function () {
      await expect(vault.connect(governor).setTreasury(bob.address)).to.emit(vault, "TreasuryUpdated");
      expect(await vault.treasury()).to.equal(bob.address);
    });

    it("rejects a zero treasury", async function () {
      await expect(
        vault.connect(governor).setTreasury(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("rejects a non-governor changing the treasury", async function () {
      await expect(
        vault.connect(alice).setTreasury(bob.address)
      ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
    });
  });

  // ------------------------------------------------------------------ pause

  describe("pause", function () {
    it("blocks new stakes while paused", async function () {
      await vault.connect(admin).pause();
      await expect(vault.connect(alice).stake(E(1))).to.be.revertedWithCustomError(
        vault,
        "EnforcedPause"
      );
    });

    it("still allows withdrawals while paused", async function () {
      await vault.connect(alice).stake(E(1000));
      await time.increase(LOCK_PERIOD + 1);
      await vault.connect(admin).pause();

      await vault.connect(alice).withdraw(E(1000));
      expect(await vault.balanceOf(alice.address)).to.equal(0);
    });

    it("still allows reward claims while paused", async function () {
      await vault.connect(alice).stake(E(1000));
      await vault.connect(funder).fundRewards(E(700), 7 * DAY);
      await time.increase(7 * DAY);
      await vault.connect(admin).pause();

      await expect(vault.connect(alice).getReward()).to.emit(vault, "RewardPaid");
    });

    it("resumes staking after unpause", async function () {
      await vault.connect(admin).pause();
      await vault.connect(admin).unpause();
      await vault.connect(alice).stake(E(1));
      expect(await vault.balanceOf(alice.address)).to.equal(E(1));
    });

    it("rejects a non-pauser calling pause", async function () {
      await expect(vault.connect(alice).pause()).to.be.revertedWithCustomError(
        vault,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("rejects a non-pauser calling unpause", async function () {
      await vault.connect(admin).pause();
      await expect(vault.connect(alice).unpause()).to.be.revertedWithCustomError(
        vault,
        "AccessControlUnauthorizedAccount"
      );
    });
  });

  // ------------------------------------------------------------------ defensive branches

  describe("reward reserve cap (harness)", function () {
    // Reaches the `reward > rewardReserve` guard in getReward(). Unreachable through the
    // public API because integer division in fundRewards always leaves the reserve
    // sufficient; the harness forces the condition to prove the guard behaves correctly.
    let harness;

    beforeEach(async function () {
      const Harness = await ethers.getContractFactory("StakingVaultHarness");
      harness = await Harness.deploy(
        await token.getAddress(),
        admin.address,
        treasury.address,
        LOCK_PERIOD,
        MIN_BOND
      );
      await harness.waitForDeployment();

      await harness.grantRole(await harness.REWARD_FUNDER_ROLE(), funder.address);
      await token.connect(alice).approve(await harness.getAddress(), E(1_000_000_000));
      await token.connect(funder).approve(await harness.getAddress(), E(1_000_000_000));

      await harness.connect(alice).stake(E(1000));
      await harness.connect(funder).fundRewards(E(700), 7 * DAY);
      await time.increase(7 * DAY);
    });

    it("caps the payout at the reserve and never touches principal", async function () {
      // Force the reserve below what the accumulator says is owed.
      await harness.forceRewardReserve(E(10));

      const before = await token.balanceOf(alice.address);
      await harness.connect(alice).getReward();

      // Paid exactly the reserve, not the full entitlement.
      expect(await token.balanceOf(alice.address)).to.equal(before + E(10));
      expect(await harness.rewardReserve()).to.equal(0);

      // Principal is untouched, and the unpaid remainder stays owed.
      expect(await harness.totalStaked()).to.equal(E(1000));
      expect(await harness.rewards(alice.address)).to.be.greaterThan(0);
    });
  });
});
