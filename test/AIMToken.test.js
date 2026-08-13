const { expect } = require("chai");
const { ethers } = require("hardhat");

const E = (n) => ethers.parseEther(n.toString());

describe("AIMToken", function () {
  let token;
  let pool, treasury, team, investors, liquidity, outsider;

  async function deploy() {
    const Token = await ethers.getContractFactory("AIMToken");
    const t = await Token.deploy(
      pool.address,
      treasury.address,
      team.address,
      investors.address,
      liquidity.address
    );
    await t.waitForDeployment();
    return t;
  }

  beforeEach(async function () {
    [pool, treasury, team, investors, liquidity, outsider] = await ethers.getSigners();
    token = await deploy();
  });

  describe("metadata", function () {
    it("has the expected name, symbol and decimals", async function () {
      expect(await token.name()).to.equal("AI Marketplace Token");
      expect(await token.symbol()).to.equal("AIM");
      expect(await token.decimals()).to.equal(18);
    });
  });

  describe("supply and allocations", function () {
    it("mints exactly MAX_SUPPLY and nothing more", async function () {
      expect(await token.totalSupply()).to.equal(E(1_000_000_000));
      expect(await token.totalSupply()).to.equal(await token.MAX_SUPPLY());
    });

    it("distributes each allocation to the correct address", async function () {
      expect(await token.balanceOf(pool.address)).to.equal(E(350_000_000));
      expect(await token.balanceOf(treasury.address)).to.equal(E(250_000_000));
      expect(await token.balanceOf(team.address)).to.equal(E(150_000_000));
      expect(await token.balanceOf(investors.address)).to.equal(E(150_000_000));
      expect(await token.balanceOf(liquidity.address)).to.equal(E(100_000_000));
    });

    it("has allocation constants summing to MAX_SUPPLY", async function () {
      const sum =
        (await token.STAKING_REWARDS_ALLOCATION()) +
        (await token.TREASURY_ALLOCATION()) +
        (await token.TEAM_ALLOCATION()) +
        (await token.INVESTOR_ALLOCATION()) +
        (await token.LIQUIDITY_ALLOCATION());
      expect(sum).to.equal(await token.MAX_SUPPLY());
    });

    it("exposes no mint function on the ABI", async function () {
      // Structural assertion: the supply cannot grow because no entrypoint exists.
      const names = token.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => f.name);
      expect(names).to.not.include("mint");
      expect(names).to.not.include("burn");
    });
  });

  describe("constructor guards", function () {
    // One case per parameter: five distinct revert branches.
    const cases = [
      ["stakingRewardsPool", 0],
      ["treasury", 1],
      ["team", 2],
      ["investors", 3],
      ["liquidity", 4]
    ];

    for (const [label, index] of cases) {
      it(`reverts when ${label} is the zero address`, async function () {
        const args = [
          pool.address,
          treasury.address,
          team.address,
          investors.address,
          liquidity.address
        ];
        args[index] = ethers.ZeroAddress;

        const Token = await ethers.getContractFactory("AIMToken");
        await expect(Token.deploy(...args))
          .to.be.revertedWithCustomError(Token, "ZeroAddress")
          .withArgs(label);
      });
    }
  });

  describe("ERC20 behaviour", function () {
    it("transfers between accounts", async function () {
      await token.connect(treasury).transfer(outsider.address, E(100));
      expect(await token.balanceOf(outsider.address)).to.equal(E(100));
    });

    it("rejects a transfer exceeding balance", async function () {
      await expect(
        token.connect(outsider).transfer(treasury.address, E(1))
      ).to.be.revertedWithCustomError(token, "ERC20InsufficientBalance");
    });

    it("honours approvals and rejects overspend", async function () {
      await token.connect(treasury).approve(outsider.address, E(50));
      expect(await token.allowance(treasury.address, outsider.address)).to.equal(E(50));

      await token.connect(outsider).transferFrom(treasury.address, outsider.address, E(50));
      expect(await token.balanceOf(outsider.address)).to.equal(E(50));

      await expect(
        token.connect(outsider).transferFrom(treasury.address, outsider.address, E(1))
      ).to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance");
    });
  });
});
