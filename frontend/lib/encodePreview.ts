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
 *
 * Robust against the on-chain struct field being absent/empty: ethers v6
 * returns a Solidity `string` as a JS string, but a deleted or unset request
 * can surface `undefined`/`null`/`""`. The previous version returned the raw
 * value from its catch branch (which could be `undefined` despite the
 * `: string` annotation), causing the preview to render blank. We now guard
 * the input and always return a real string.
 */
export function decodePreview(encoded: string | undefined | null): string {
  if (!encoded) return "";
  try {
    return ethers.toUtf8String(encoded);
  } catch {
    // Not valid UTF-8 hex (e.g. already-decoded plaintext or garbage). Surface
    // the raw value rather than swallowing it as undefined.
    return encoded;
  }
}