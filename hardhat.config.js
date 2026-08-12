require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-network-helpers");
require("@nomicfoundation/hardhat-verify");
require("solidity-coverage");

/**
 * Deliberate choices, all of which are documented in the final report:
 *
 *  - No TypeScript and no typechain. Fewer moving parts, fewer version conflicts.
 *  - evmVersion "paris" rather than the 0.8.24 default of "cancun". Paris avoids
 *    PUSH0 and MCOPY, so identical bytecode deploys cleanly on any EVM testnet
 *    regardless of how recently it forked.
 *  - No network entries beyond the built-in Hardhat network. Testnet deployment
 *    happens from Remix via MetaMask, so no private key ever enters this repo.
 */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "paris"
    }
  },
  networks: {
    hardhat: { chainId: 31337 }
  },
  mocha: { timeout: 60000 }
};
