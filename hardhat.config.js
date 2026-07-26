require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  // Default Solidity compiler version aligned with OpenZeppelin v5 and the contract.
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },

  // Network configuration for local testing and Flare Coston2 deployment.
  networks: {
    // Built-in Hardhat network used by `npx hardhat test`.
    hardhat: {
      chainId: 31337,
      accounts: {
        count: 200,
        accountsBalance: "10000000000000000000000", // 10,000 ETH per test account
      },
    },

    // Flare Coston2 testnet (Chain ID 114).
    // RPC endpoint: https://coston2-api.flare.network/ext/C/rpc
    coston2: {
      url: "https://coston2-api.flare.network/ext/C/rpc",
      chainId: 114,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },

  // Etherscan-compatible verification configuration for Flare explorers.
  // Update the apiKey and customChains entries if you use a Flare block explorer.
  etherscan: {
    apiKey: {
      coston2: process.env.FLARESCAN_API_KEY || "unset",
    },
    customChains: [
      {
        network: "coston2",
        chainId: 114,
        urls: {
          apiURL: "https://api.routescan.io/v2/network/testnet/evm/114/etherscan",
          browserURL: "https://coston2.testnet.flarescan.com",
        },
      },
    ],
  },

  // Optional path overrides (match Hardhat defaults, explicit for clarity).
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};
