import "dotenv/config";

/**
 * @notice Operation constants and verification thresholds.
 * @dev The OPType/OPCommand strings must match the bytes32 constants in
 *      KnockKnockFCCVerifier.sol exactly (case-sensitive).
 */

/** Extension version reported in TEE state. */
export const VERSION = "0.1.0";

/** Operation namespace — must mirror `OP_TYPE_KNOCKKNOCK` in Solidity. */
export const OP_TYPE_KNOCKKNOCK = "KNOCKKNOCK";

/** Verification command — must mirror `OP_COMMAND_VERIFY_SENDER` in Solidity. */
export const OP_COMMAND_VERIFY_SENDER = "VERIFY_SENDER";

/** Minimum wallet age to satisfy Proof-of-History, in days. */
const configuredWalletAgeDays = Number(
  process.env.REQUIRED_WALLET_AGE_DAYS ?? "0",
);
if (!Number.isInteger(configuredWalletAgeDays) || configuredWalletAgeDays < 0) {
  throw new Error(
    "REQUIRED_WALLET_AGE_DAYS must be a non-negative integer",
  );
}
export const REQUIRED_WALLET_AGE_DAYS = configuredWalletAgeDays;

/** Minimum wallet age to satisfy Proof-of-History, in seconds. */
export const MIN_WALLET_AGE_SECONDS = REQUIRED_WALLET_AGE_DAYS * 24 * 60 * 60;

/** Minimum Human Passport score to satisfy Proof-of-Humanity. */
export const HUMANITY_SCORE_THRESHOLD = 0;

/** Flare RPC endpoint used to query wallet history. */
export const FLARE_RPC_URL =
  process.env.FLARE_RPC_URL ?? "https://coston2-api.flare.network/ext/C/rpc";

/** Human Passport API key. Keep this secret — it lives only inside the TEE. */
export const PASSPORT_API_KEY = process.env.PASSPORT_API_KEY ?? "";

/** Human Passport scorer ID used to route score requests. */
const configuredScorerId = Number(process.env.PASSPORT_SCORER_ID ?? "12119");
if (!Number.isInteger(configuredScorerId) || configuredScorerId <= 0) {
  throw new Error("PASSPORT_SCORER_ID must be a positive integer");
}
export const PASSPORT_SCORER_ID = configuredScorerId;

/** Human Passport base URL for scorer API calls. */
export const PASSPORT_API_URL =
  process.env.PASSPORT_API_URL ?? "https://api.scorer.gitcoin.co/registry/score";

/** Human Passport endpoint for submitting a wallet to a scorer. */
export const PASSPORT_SUBMIT_URL =
  process.env.PASSPORT_SUBMIT_URL ?? "https://api.scorer.gitcoin.co/registry/submit-passport";

/** Optional identity API endpoint for Proof-of-Humanity (legacy fallback). */
export const IDENTITY_API_URL = process.env.IDENTITY_API_URL ?? "";

/** Private key used by this TEE extension to sign verification results. */
export const TEE_SIGNER_PRIVATE_KEY = process.env.TEE_SIGNER_PRIVATE_KEY ?? "";

/**
 * Determine whether a string looks like a real API key rather than an empty
 * value or a placeholder such as <INSERT_YOUR_API_KEY_HERE>.
 */
function isRealApiKey(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const placeholderMarkers = [
    "<",
    ">",
    "INSERT",
    "YOUR_",
    "TODO",
    "FIXME",
    "EXAMPLE",
    "REPLACE",
    "PLACEHOLDER",
  ];
  const upper = trimmed.toUpperCase();
  return !placeholderMarkers.some((marker) => upper.includes(marker));
}

/**
 * Verify that the required Human Passport configuration is present.
 * @throws {Error} "Missing Human Passport configuration" if the API key or
 *                 scorer ID is missing.
 * @dev Call this once at server startup before accepting requests. Never log
 *      the full secret.
 */
export function validateEnvironment(): void {
  if (!isRealApiKey(PASSPORT_API_KEY) || !PASSPORT_SCORER_ID) {
    throw new Error("Missing Human Passport configuration");
  }
  console.log("✓ Human Passport API key loaded");
  console.log("✓ Human Passport Scorer ID loaded");
}
