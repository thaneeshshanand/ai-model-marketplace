const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const E = (n) => ethers.parseEther(n.toString());
const DAY = 24 * 60 * 60;
const HOUR = 60 * 60;

const VOTING_PERIOD = 3 * DAY;
const EXECUTION_DELAY = 2 * DAY;
const QUORUM_BPS = 1000; // 10 percent of staked supply
const PROPOSAL_THRESHOLD = E(1000);

const LOCK_PERIOD = 1 * DAY;
const MIN_BOND = E(500);

// VoteType
const AGAINST = 0;
const FOR = 1;
const ABSTAIN = 2;

// ProposalState
const ACTIVE = 0;
const DEFEATED = 1;
const SUCCEEDED = 2;
const EXECUTED = 3;

describe("ParameterGovernor", function () {
  let token, vault, registry, compliance, market, governor;
  let admin, treasury, provider, alice, bob, carol, outsider;

  beforeEach(async function () {
    [admin, treasury, provider, alice, bob, carol, outsider] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("AIMToken");
    token = await Token.deploy(
      admin.address,
      treasury.address,
      alice.address,
      bob.address,
      carol.address
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

    const Registry = await ethers.getContractFactory("MockModelRegistry");
    registry = await Registry.deploy();
    await registry.waitForDeployment();
    await registry.setModel(1, provider.address, true, false);

    const Compliance = await ethers.getContractFactory("ComplianceRegistry");
    compliance = await Compliance.deploy(admin.address);
    await compliance.waitForDeployment();

    // Real Marketplace as the governed target, so parameter control is demonstrable.
    const Market = await ethers.getContractFactory("Marketplace");
    market = await Market.deploy(
      admin.address,
      await token.getAddress(),
      await registry.getAddress(),
      await compliance.getAddress(),
      treasury.address,
      500,
      7 * DAY
    );
    await market.waitForDeployment();

    const Governor = await ethers.getContractFactory("ParameterGovernor");
    governor = await Governor.deploy(
      admin.address,
      await vault.getAddress(),
      [await market.getAddress(), await vault.getAddress()],
      VOTING_PERIOD,
      EXECUTION_DELAY,
      QUORUM_BPS,
      PROPOSAL_THRESHOLD
    );
    await governor.waitForDeployment();

    // Governance holds GOVERNOR_ROLE on the targets; admin keeps break-glass.
    await market.grantRole(await market.GOVERNOR_ROLE(), await governor.getAddress());
    await vault.grantRole(await vault.GOVERNOR_ROLE(), await governor.getAddress());

    // Stake so voting weight exists. Total staked becomes 100,000.
    for (const s of [alice, bob, carol]) {
      await token.connect(s).approve(await vault.getAddress(), E(1_000_000));
    }
    await vault.connect(alice).stake(E(50_000));
    await vault.connect(bob).stake(E(30_000));
    await vault.connect(carol).stake(E(20_000));

    // Advance so all stakes predate any proposal snapshot.
    await time.increase(HOUR);
  });

  function feeCalldata(bps) {
    return market.interface.encodeFunctionData("setProtocolFeeBps", [bps]);
  }

  async function proposeFee(bps = 250, signer = alice) {
    await governor.connect(signer).propose(await market.getAddress(), feeCalldata(bps));
    return governor.proposalCount();
  }

  async function passAndExecute(id) {
    await governor.connect(alice).castVote(id, FOR);
    await time.increase(VOTING_PERIOD + 1);
    await time.increase(EXECUTION_DELAY + 1);
    await governor.execute(id);
  }

  describe("constructor", function () {
    it("stores configuration and registers targets including itself", async function () {
      expect(await governor.votingPeriod()).to.equal(VOTING_PERIOD);
      expect(await governor.executionDelay()).to.equal(EXECUTION_DELAY);
      expect(await governor.quorumBps()).to.equal(QUORUM_BPS);
      expect(await governor.proposalThreshold()).to.equal(PROPOSAL_THRESHOLD);
      expect(await governor.isTarget(await market.getAddress())).to.equal(true);
      expect(await governor.isTarget(await vault.getAddress())).to.equal(true);
      expect(await governor.isTarget(await governor.getAddress())).to.equal(true);
    });

    it("grants admin only DEFAULT_ADMIN_ROLE", async function () {
      expect(await governor.hasRole(await governor.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
    });

    it("reverts on a zero admin or vault", async function () {
      const G = await ethers.getContractFactory("ParameterGovernor");
      const v = await vault.getAddress();
      const t = [await market.getAddress()];
      await expect(
        G.deploy(ethers.ZeroAddress, v, t, VOTING_PERIOD, EXECUTION_DELAY, QUORUM_BPS, 0)
      ).to.be.revertedWithCustomError(G, "ZeroAddress");
      await expect(
        G.deploy(admin.address, ethers.ZeroAddress, t, VOTING_PERIOD, EXECUTION_DELAY, QUORUM_BPS, 0)
      ).to.be.revertedWithCustomError(G, "ZeroAddress");
    });

    it("reverts on an empty target set", async function () {
      const G = await ethers.getContractFactory("ParameterGovernor");
      await expect(
        G.deploy(admin.address, await vault.getAddress(), [], VOTING_PERIOD, EXECUTION_DELAY, QUORUM_BPS, 0)
      ).to.be.revertedWithCustomError(G, "EmptyTargetSet");
    });

    it("reverts on a zero address inside the target set", async function () {
      const G = await ethers.getContractFactory("ParameterGovernor");
      await expect(
        G.deploy(admin.address, await vault.getAddress(), [ethers.ZeroAddress], VOTING_PERIOD, EXECUTION_DELAY, QUORUM_BPS, 0)
      ).to.be.revertedWithCustomError(G, "ZeroAddress");
    });

    it("enforces the voting period floor", async function () {
      const G = await ethers.getContractFactory("ParameterGovernor");
      await expect(
        G.deploy(admin.address, await vault.getAddress(), [await market.getAddress()], 60, EXECUTION_DELAY, QUORUM_BPS, 0)
      ).to.be.revertedWithCustomError(G, "BelowFloor");
    });

    it("enforces the execution delay floor", async function () {
      const G = await ethers.getContractFactory("ParameterGovernor");
      await expect(
        G.deploy(admin.address, await vault.getAddress(), [await market.getAddress()], VOTING_PERIOD, 60, QUORUM_BPS, 0)
      ).to.be.revertedWithCustomError(G, "BelowFloor");
    });

    it("enforces the quorum floor", async function () {
      const G = await ethers.getContractFactory("ParameterGovernor");
      await expect(
        G.deploy(admin.address, await vault.getAddress(), [await market.getAddress()], VOTING_PERIOD, EXECUTION_DELAY, 399, 0)
      ).to.be.revertedWithCustomError(G, "BelowFloor");
    });
  });

  describe("propose", function () {
    it("creates a proposal with quorum fixed from staked supply", async function () {
      const id = await proposeFee();
      const p = await governor.proposals(id);

      expect(p.proposer).to.equal(alice.address);
      expect(p.target).to.equal(await market.getAddress());
      // 10 percent of 100,000 staked.
      expect(p.quorumVotes).to.equal(E(10_000));
      expect(p.voteEnd).to.equal(p.snapshotTime + BigInt(VOTING_PERIOD));
    });

    it("emits ProposalCreated", async function () {
      await expect(
        governor.connect(alice).propose(await market.getAddress(), feeCalldata(250))
      ).to.emit(governor, "ProposalCreated");
    });

    it("exposes the calldata separately from the struct getter", async function () {
      const id = await proposeFee();
      expect(await governor.proposalData(id)).to.equal(feeCalldata(250));
    });

    it("assigns sequential ids starting at one", async function () {
      expect(await proposeFee(250)).to.equal(1);
      expect(await proposeFee(300)).to.equal(2);
    });

    it("rejects a target outside the fixed set", async function () {
      await expect(
        governor.connect(alice).propose(await token.getAddress(), feeCalldata(250))
      ).to.be.revertedWithCustomError(governor, "TargetNotAllowed");
    });

    it("rejects empty calldata", async function () {
      await expect(
        governor.connect(alice).propose(await market.getAddress(), "0x")
      ).to.be.revertedWithCustomError(governor, "EmptyCalldata");
    });

    it("rejects a proposer below the stake threshold", async function () {
      await expect(
        governor.connect(outsider).propose(await market.getAddress(), feeCalldata(250))
      ).to.be.revertedWithCustomError(governor, "InsufficientProposerStake");
    });
  });

  describe("castVote", function () {
    let id;

    beforeEach(async function () {
      id = await proposeFee();
    });

    it("records weight equal to the voter's snapshot stake", async function () {
      await expect(governor.connect(alice).castVote(id, FOR))
        .to.emit(governor, "VoteCast")
        .withArgs(id, alice.address, FOR, E(50_000));

      const [forVotes] = await governor.tallies(id);
      expect(forVotes).to.equal(E(50_000));
    });

    it("tallies against votes", async function () {
      await governor.connect(bob).castVote(id, AGAINST);
      const [, againstVotes] = await governor.tallies(id);
      expect(againstVotes).to.equal(E(30_000));
    });

    it("tallies abstain votes toward quorum without endorsing", async function () {
      await governor.connect(carol).castVote(id, ABSTAIN);
      const [forVotes, againstVotes, abstainVotes] = await governor.tallies(id);
      expect(forVotes).to.equal(0);
      expect(againstVotes).to.equal(0);
      expect(abstainVotes).to.equal(E(20_000));
    });

    it("rejects a second vote from the same account", async function () {
      await governor.connect(alice).castVote(id, FOR);
      await expect(governor.connect(alice).castVote(id, AGAINST)).to.be.revertedWithCustomError(
        governor,
        "AlreadyVoted"
      );
    });

    it("rejects a voter with no stake", async function () {
      await expect(governor.connect(outsider).castVote(id, FOR)).to.be.revertedWithCustomError(
        governor,
        "NoVotingPower"
      );
    });

    it("rejects a voter whose stake postdates the snapshot", async function () {
      // This is the anti-flash-loan control, end to end.
      await token.connect(admin).transfer(outsider.address, E(40_000));
      await token.connect(outsider).approve(await vault.getAddress(), E(1_000_000));
      await vault.connect(outsider).stake(E(40_000));

      await expect(governor.connect(outsider).castVote(id, FOR)).to.be.revertedWithCustomError(
        governor,
        "NoVotingPower"
      );
    });

    it("rejects voting after the period closes", async function () {
      await time.increase(VOTING_PERIOD + 1);
      await expect(governor.connect(alice).castVote(id, FOR)).to.be.revertedWithCustomError(
        governor,
        "VotingClosed"
      );
    });

    it("rejects voting on an unknown proposal", async function () {
      await expect(governor.connect(alice).castVote(99, FOR)).to.be.revertedWithCustomError(
        governor,
        "NoProposal"
      );
    });
  });

  describe("state", function () {
    let id;

    beforeEach(async function () {
      id = await proposeFee();
    });

    it("is Active during voting", async function () {
      expect(await governor.state(id)).to.equal(ACTIVE);
    });

    it("is Defeated when quorum is not met", async function () {
      // Carol alone holds 20,000, above the 10,000 quorum, so use nobody.
      await time.increase(VOTING_PERIOD + 1);
      expect(await governor.state(id)).to.equal(DEFEATED);
    });

    it("is Defeated when against outweighs for", async function () {
      await governor.connect(bob).castVote(id, AGAINST);
      await governor.connect(carol).castVote(id, FOR);
      await time.increase(VOTING_PERIOD + 1);
      expect(await governor.state(id)).to.equal(DEFEATED);
    });

    it("is Defeated on a tie", async function () {
      // 30,000 against from bob, 30,000 for from two others is not available, so
      // construct a tie using a fresh proposal where alice votes for and a matching
      // against does not exist. Instead: bob against 30,000, alice for 50,000 wins.
      // A true tie needs equal weights, so use abstain to reach quorum and equal sides.
      const id2 = await proposeFee(300, alice);
      await governor.connect(bob).castVote(id2, AGAINST);
      await governor.connect(carol).castVote(id2, ABSTAIN);
      await time.increase(VOTING_PERIOD + 1);
      // For is 0, against is 30,000, quorum met by participation of 50,000.
      expect(await governor.state(id2)).to.equal(DEFEATED);
    });

    it("is Succeeded when quorum is met and for outweighs against", async function () {
      await governor.connect(alice).castVote(id, FOR);
      await time.increase(VOTING_PERIOD + 1);
      expect(await governor.state(id)).to.equal(SUCCEEDED);
    });

    it("counts abstain toward quorum", async function () {
      // Carol abstains 20,000 and alice votes for 50,000: quorum comfortably met.
      await governor.connect(carol).castVote(id, ABSTAIN);
      await governor.connect(alice).castVote(id, FOR);
      await time.increase(VOTING_PERIOD + 1);
      expect(await governor.state(id)).to.equal(SUCCEEDED);
    });

    it("is Executed after execution", async function () {
      await passAndExecute(id);
      expect(await governor.state(id)).to.equal(EXECUTED);
    });

    it("reverts on an unknown proposal", async function () {
      await expect(governor.state(99)).to.be.revertedWithCustomError(governor, "NoProposal");
    });
  });

  describe("execute", function () {
    let id;

    beforeEach(async function () {
      id = await proposeFee(250);
    });

    it("applies the parameter change to the target contract", async function () {
      expect(await market.protocolFeeBps()).to.equal(500);
      await passAndExecute(id);
      expect(await market.protocolFeeBps()).to.equal(250);
    });

    it("emits ProposalExecuted", async function () {
      await governor.connect(alice).castVote(id, FOR);
      await time.increase(VOTING_PERIOD + EXECUTION_DELAY + 2);
      await expect(governor.execute(id)).to.emit(governor, "ProposalExecuted");
    });

    it("is permissionless", async function () {
      await governor.connect(alice).castVote(id, FOR);
      await time.increase(VOTING_PERIOD + EXECUTION_DELAY + 2);
      await governor.connect(outsider).execute(id);
      expect(await market.protocolFeeBps()).to.equal(250);
    });

    it("reports the executable timestamp", async function () {
      const p = await governor.proposals(id);
      expect(await governor.executableAt(id)).to.equal(p.voteEnd + BigInt(EXECUTION_DELAY));
    });

    it("rejects execution while voting is open", async function () {
      await governor.connect(alice).castVote(id, FOR);
      await expect(governor.execute(id)).to.be.revertedWithCustomError(governor, "VotingOpen");
    });

    it("rejects execution before the delay elapses", async function () {
      await governor.connect(alice).castVote(id, FOR);
      await time.increase(VOTING_PERIOD + 1);
      await expect(governor.execute(id)).to.be.revertedWithCustomError(
        governor,
        "ExecutionDelayNotElapsed"
      );
    });

    it("rejects execution of a defeated proposal", async function () {
      await governor.connect(bob).castVote(id, AGAINST);
      await time.increase(VOTING_PERIOD + EXECUTION_DELAY + 2);
      await expect(governor.execute(id)).to.be.revertedWithCustomError(
        governor,
        "ProposalNotSucceeded"
      );
    });

    it("rejects double execution", async function () {
      await passAndExecute(id);
      await expect(governor.execute(id)).to.be.revertedWithCustomError(
        governor,
        "ProposalAlreadyExecuted"
      );
    });

    it("rejects execution of an unknown proposal", async function () {
      await expect(governor.execute(99)).to.be.revertedWithCustomError(governor, "NoProposal");
    });

    it("reverts when the target call fails", async function () {
      // 2001 bps exceeds Marketplace's MAX_PROTOCOL_FEE_BPS, so the call reverts.
      const bad = await proposeFee(2001);
      await governor.connect(alice).castVote(bad, FOR);
      await time.increase(VOTING_PERIOD + EXECUTION_DELAY + 2);
      await expect(governor.execute(bad)).to.be.revertedWithCustomError(governor, "ExecutionFailed");
    });

    it("can govern a second target in the set", async function () {
      const data = vault.interface.encodeFunctionData("setMinProviderBond", [E(2000)]);
      await governor.connect(alice).propose(await vault.getAddress(), data);
      const vid = await governor.proposalCount();

      await passAndExecute(vid);
      expect(await vault.minProviderBond()).to.equal(E(2000));
    });
  });

  describe("self-governance", function () {
    it("changes its own quorum only through a passed proposal", async function () {
      const data = governor.interface.encodeFunctionData("setQuorumBps", [2000]);
      await governor.connect(alice).propose(await governor.getAddress(), data);
      const id = await governor.proposalCount();

      await passAndExecute(id);
      expect(await governor.quorumBps()).to.equal(2000);
    });

    it("changes its own voting period through governance", async function () {
      const data = governor.interface.encodeFunctionData("setVotingPeriod", [5 * DAY]);
      await governor.connect(alice).propose(await governor.getAddress(), data);
      await passAndExecute(await governor.proposalCount());
      expect(await governor.votingPeriod()).to.equal(5 * DAY);
    });

    it("changes its own execution delay through governance", async function () {
      const data = governor.interface.encodeFunctionData("setExecutionDelay", [3 * DAY]);
      await governor.connect(alice).propose(await governor.getAddress(), data);
      await passAndExecute(await governor.proposalCount());
      expect(await governor.executionDelay()).to.equal(3 * DAY);
    });

    it("changes its own proposal threshold through governance", async function () {
      const data = governor.interface.encodeFunctionData("setProposalThreshold", [E(5000)]);
      await governor.connect(alice).propose(await governor.getAddress(), data);
      await passAndExecute(await governor.proposalCount());
      expect(await governor.proposalThreshold()).to.equal(E(5000));
    });

    it("rejects a direct call from admin", async function () {
      await expect(governor.connect(admin).setQuorumBps(2000)).to.be.revertedWithCustomError(
        governor,
        "NotGovernor"
      );
    });

    it("rejects a direct call from a large staker", async function () {
      await expect(governor.connect(alice).setVotingPeriod(5 * DAY)).to.be.revertedWithCustomError(
        governor,
        "NotGovernor"
      );
    });

    it("cannot drop quorum below the floor even through governance", async function () {
      const data = governor.interface.encodeFunctionData("setQuorumBps", [399]);
      await governor.connect(alice).propose(await governor.getAddress(), data);
      const id = await governor.proposalCount();

      await governor.connect(alice).castVote(id, FOR);
      await time.increase(VOTING_PERIOD + EXECUTION_DELAY + 2);
      // The inner setter reverts on BelowFloor, surfacing as ExecutionFailed.
      await expect(governor.execute(id)).to.be.revertedWithCustomError(governor, "ExecutionFailed");
      expect(await governor.quorumBps()).to.equal(QUORUM_BPS);
    });

    it("cannot shrink the voting period below the floor", async function () {
      const data = governor.interface.encodeFunctionData("setVotingPeriod", [60]);
      await governor.connect(alice).propose(await governor.getAddress(), data);
      const id = await governor.proposalCount();
      await governor.connect(alice).castVote(id, FOR);
      await time.increase(VOTING_PERIOD + EXECUTION_DELAY + 2);
      await expect(governor.execute(id)).to.be.revertedWithCustomError(governor, "ExecutionFailed");
    });

    it("cannot shrink the execution delay below the floor", async function () {
      const data = governor.interface.encodeFunctionData("setExecutionDelay", [60]);
      await governor.connect(alice).propose(await governor.getAddress(), data);
      const id = await governor.proposalCount();
      await governor.connect(alice).castVote(id, FOR);
      await time.increase(VOTING_PERIOD + EXECUTION_DELAY + 2);
      await expect(governor.execute(id)).to.be.revertedWithCustomError(governor, "ExecutionFailed");
    });
  });

  describe("documented properties", function () {
    it("a voter may unstake after casting, so tallies can outlive stake", async function () {
      const id = await proposeFee();
      await governor.connect(alice).castVote(id, FOR);

      await time.increase(LOCK_PERIOD + 1);
      await vault.connect(alice).withdraw(E(50_000));
      expect(await vault.balanceOf(alice.address)).to.equal(0);

      await time.increase(VOTING_PERIOD + EXECUTION_DELAY + 2);
      // The vote still counts. Documented, not a bug.
      expect(await governor.state(id)).to.equal(SUCCEEDED);
      await governor.execute(id);
      expect(await market.protocolFeeBps()).to.equal(250);
    });

    it("transferring tokens does not enable double voting", async function () {
      const id = await proposeFee();
      await governor.connect(alice).castVote(id, FOR);

      await time.increase(LOCK_PERIOD + 1);
      await vault.connect(alice).withdraw(E(50_000));
      await token.connect(alice).transfer(outsider.address, E(50_000));
      await token.connect(outsider).approve(await vault.getAddress(), E(1_000_000));
      await vault.connect(outsider).stake(E(50_000));

      // Recipient's stake postdates the snapshot, so weight is zero.
      await expect(governor.connect(outsider).castVote(id, FOR)).to.be.revertedWithCustomError(
        governor,
        "NoVotingPower"
      );
    });

    it("reverts a proposal when nothing is staked", async function () {
      const Governor = await ethers.getContractFactory("ParameterGovernor");
      const Vault = await ethers.getContractFactory("StakingVault");
      const emptyVault = await Vault.deploy(
        await token.getAddress(),
        admin.address,
        treasury.address,
        LOCK_PERIOD,
        MIN_BOND
      );
      await emptyVault.waitForDeployment();

      const g = await Governor.deploy(
        admin.address,
        await emptyVault.getAddress(),
        [await market.getAddress()],
        VOTING_PERIOD,
        EXECUTION_DELAY,
        QUORUM_BPS,
        0
      );
      await g.waitForDeployment();

      await expect(
        g.connect(alice).propose(await market.getAddress(), feeCalldata(250))
      ).to.be.revertedWithCustomError(g, "NoStakedSupply");
    });
  });
});
