import { ethers } from "ethers";

/**
 * Encode a plain-text preview message to a hex string before storing it
 * on-chain. This keeps the payload opaque to casual RPC readers but is NOT
 * true end-to-end encryption.
 *
 * For a production dApp, replace this with a real E2E encryption step using
 * the receiver's public key.
 */
export function encodePreview(plainText: string): string {
  return ethers.hexlify(ethers.toUtf8Bytes(plainText));
}

/**
 * Decode a hex-encoded preview message back to a readable string.
 */
export function decodePreview(encoded: string): string {
  try {
    return ethers.toUtf8String(encoded);
  } catch {
    return encoded;
  }
}
