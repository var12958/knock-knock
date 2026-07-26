/**
 * Flare Coston2 testnet configuration.
 * Chain ID: 114
 * Public RPC: https://coston2-api.flare.network/ext/C/rpc
 */

export const COSTON2_CHAIN_ID = 114;

export const COSTON2_CONFIG = {
  chainId: "0x" + COSTON2_CHAIN_ID.toString(16),
  chainName: "Flare Coston2",
  nativeCurrency: {
    name: "Coston2 Flare",
    symbol: "C2FLR",
    decimals: 18,
  },
  rpcUrls: ["https://coston2-api.flare.network/ext/C/rpc"],
  blockExplorerUrls: ["https://coston2.testnet.flarescan.com"],
};
