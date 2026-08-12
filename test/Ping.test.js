const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

/**
 * Phase 0 validation suite.
 *
 * Each test deliberately exercises a different part of the stack, so a failure
 * tells us precisely which dependency is misbehaving:
 *
 *   "deploys"          -> hardhat-ethers wiring and ethers v6 API
 *   "increments"       -> basic state reads
 *   "emits"            -> hardhat-chai-matchers event assertions
 *   "rejects too soon" -> hardhat-chai-matchers custom error assertions
 *   "allows after"     -> hardhat-network-helpers time manipulation
 */
describe("Ping (Phase 0 toolchain validation)", function () {
  let ping;
  let deployer;
  let stranger;

  beforeEach(async function () {
    [deployer, stranger] = await ethers.getSigners();
    const Ping = await ethers.getContractFactory("Ping");
    ping = await Ping.deploy();
    await ping.waitForDeployment();
  });

  it("deploys and records the deployer as owner", async function () {
    expect(await ping.owner()).to.equal(deployer.address);
    expect(await ping.pingCount()).to.equal(0n);
    expect(await ping.COOLDOWN()).to.equal(10n);
  });

  it("increments the counter on the first ping", async function () {
    await ping.ping();
    expect(await ping.pingCount()).to.equal(1n);
    expect(await ping.lastPingAt()).to.be.greaterThan(0n);
  });

  it("emits Pinged with the caller and the new count", async function () {
    // anyValue is passed uncalled: it is a predicate the matcher invokes itself.
    await expect(ping.connect(stranger).ping())
      .to.emit(ping, "Pinged")
      .withArgs(stranger.address, 1n, anyValue);
  });

  it("rejects a second ping inside the cooldown window", async function () {
    await ping.ping();
    await expect(ping.ping()).to.be.revertedWithCustomError(ping, "TooSoon");
  });

  it("allows a second ping once the cooldown has elapsed", async function () {
    await ping.ping();
    await time.increase(11);
    await ping.ping();
    expect(await ping.pingCount()).to.equal(2n);
  });
});
