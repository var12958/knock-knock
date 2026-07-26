import CryptoJS from "crypto-js";
import { ethers } from "ethers";

/**
 * Derive a deterministic shared AES key from two participant addresses.
 *
 * IMPORTANT SECURITY NOTE (HACKATHON ONLY):
 * Wallet addresses are public. Anyone can compute this key, so this is NOT
 * secure against a passive observer. It is only a minimal privacy layer for
 * the demo. For production, replace this with a proper key exchange such as
 * ECDH, or encrypt the shared secret off-chain via a trusted channel.
 */
export function deriveChatKey(addressA: string, addressB: string): string {
  const sorted = [addressA.toLowerCase(), addressB.toLowerCase()].sort();
  const hash = ethers.keccak256(
    ethers.solidityPacked(
      ["string", "address", "address"],
      ["knockknock-chat-salt-v1", sorted[0], sorted[1]]
    )
  );
  // AES key: first 32 hex chars = 128 bits. Extend to 256 bits by repeating.
  const keyPart = hash.slice(2, 34);
  return keyPart + keyPart;
}

/**
 * Encrypt a plaintext chat message with AES.
 * Returns a hex string that can be stored in Firebase.
 */
export function encryptMessage(plainText: string, key: string): string {
  return CryptoJS.AES.encrypt(plainText, key).toString();
}

/**
 * Decrypt an AES-encrypted chat message.
 * If decryption fails (wrong key / corrupted data), returns null.
 */
export function decryptMessage(cipherText: string, key: string): string | null {
  try {
    const bytes = CryptoJS.AES.decrypt(cipherText, key);
    const plain = bytes.toString(CryptoJS.enc.Utf8);
    return plain || null;
  } catch {
    return null;
  }
}
