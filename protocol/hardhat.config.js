require("@nomicfoundation/hardhat-toolbox");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.26",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: false,
      // Uniswap v4 uses transient storage (tstore/tload), which requires Cancun.
      // Robinhood Chain must therefore be Cancun-capable to host v4 at all.
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
      hardfork: "cancun",
      // Robinhood Chain is an L2; block gas limits are generous but we keep the
      // default so the batch-distribution gas numbers we measure stay honest.
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
  },
  gasReporter: { enabled: false },
};
