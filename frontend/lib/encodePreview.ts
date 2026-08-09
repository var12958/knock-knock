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
  if (!plainText || plainText.trim().length === 0) {
    throw new Error("Preview message cannot be empty");
  }
  return ethers.hexlify(ethers.toUtf8Bytes(plainText));
}

/**
 * Decode a hex-encoded preview message back to a readable string.
 *
 * Handles the formats we expect from the on-chain mailbox:
 * - `undefined` / `null` / `""` / `"0x"` / `"0x0"` → empty string
 * - Hex with a `0x` or `0X` prefix (the normal output of `encodePreview`)
 * - Hex without a prefix (some RPCs or tooling strip the prefix)
 * - Already-decoded plaintext (passthrough)
 * - Invalid hex / non-UTF-8 data → raw value is returned instead of empty
 *
 * Trailing NUL bytes (Solidity padding) are stripped, and the result is
 * trimmed so whitespace-only previews collapse to empty and callers can fall
 * back to their "no preview" placeholder.
 */
export function decodePreview(encoded: unknown): string {
  if (encoded == null) return "";

  const raw = String(encoded).trim();
  if (
    raw === "" ||
    raw === "0x" ||
    raw === "0x0" ||
    raw === "0X" ||
    raw === "0X0"
  ) {
    return "";
  }

  if (isHexString(raw)) {
    const hex = hasHexPrefix(raw) ? raw : `0x${raw}`;
    try {
      const decoded = ethers.toUtf8String(hex);
      return stripSolidityPadding(decoded);
    } catch {
      // The value looks like hex but is not valid UTF-8 (e.g. corrupted
      // data). Surface the raw value rather than returning empty, so the
      // UI never shows "No preview" for a message that really exists.
      return raw;
    }
  }

  // Not hex: treat as already-decoded plaintext.
  return stripSolidityPadding(raw);
}

function hasHexPrefix(value: string): boolean {
  return value.startsWith("0x") || value.startsWith("0X");
}

function isHexString(value: string): boolean {
  const body = hasHexPrefix(value) ? value.slice(2) : value;
  return (
    body.length > 0 &&
    body.length % 2 === 0 &&
    /^[0-9a-fA-F]+$/.test(body)
  );
}

function stripSolidityPadding(value: string): string {
  return value.replace(/\0+$/, "").trim();
}
