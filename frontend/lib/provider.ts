import { ethers } from "ethers";
import { COSTON2_CONFIG } from "./chain";

/**
 * Create a read-only provider pointing at the Flare Coston2 RPC.
 * Use this for view calls when the user has not connected a wallet.
 */
export function getReadProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(COSTON2_CONFIG.rpcUrls[0]);
}

/**
 * Wrap `window.ethereum` as an ethers BrowserProvider.
 * Only call this inside functions/components executed in the browser.
 */
export function getBrowserProvider(): ethers.BrowserProvider | null {
  if (typeof window === "undefined" || !(window as any).ethereum) {
    return null;
  }
  return new ethers.BrowserProvider((window as any).ethereum);
}

/**
 * Request a signer from the connected wallet.
 */
export async function getSigner(): Promise<ethers.JsonRpcSigner | null> {
  const provider = getBrowserProvider();
  if (!provider) return null;
  return provider.getSigner();
}
