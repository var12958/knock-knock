/**
 * Flare Coston2 testnet configuration.
 * Chain ID: 114
 * Public RPC: https://coston2-api.flare.network/ext/C/rpc
 */

export const COSTON2_CHAIN_ID = 114;

/**
 * Warm, user-friendly message shown when the wallet does not have the Flare
 * Coston2 network added and `wallet_addEthereumChain` fails (or is rejected).
 * Used as an `errorKind: "network"` signal in the UI so the banner can render
 * with a warm tone instead of a harsh RPC failure dump.
 */
export const COSTON2_ADD_PROMPT =
  "The required network is not present in your wallet.\n\n" +
  "Go to MetaMask → Networks → Add network manually, then add Flare Coston2 using:\n\n" +
  "RPC: https://coston2-api.flare.network/ext/C/rpc\n" +
  "Chain ID: 114\n" +
  "Currency: C2FLR";

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
