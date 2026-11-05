// A local fork of Robinhood Chain mainnet for end-to-end tests.
// Cancun is needed by the Kudo contract's reads; ganache does not support it.
module.exports = {
  networks: {
    hardhat: {
      chainId: 4663,
      hardfork: "prague",
      forking: { url: process.env.KUDO_FORK_RPC || "https://rpc.mainnet.chain.robinhood.com" },
      chains: { 4663: { hardforkHistory: { prague: 0 } } },
    },
  },
};
