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

/**
 * Twitter verification command.
 * @dev Unlike VERIFY_SENDER, this is a pure off-chain Web2 attestation produced
 *      by the Flare Data Connector (FDC). It does not require an on-chain
 *      mailbox settlement; the TEE returns the FDC-verified boolean and the
 *      client persists it to Firebase. There is therefore no Solidity
 *      constant to mirror.
 */
export const OP_COMMAND_VERIFY_TWITTER = "VERIFY_TWITTER";

/**
 * On-chain behavioral Sybil-detection command.
 * @dev Triggered manually from a chat room. The TEE ingests the target wallet's
 *      recent transaction history, runs a heuristic ML model, and returns a
 *      signed human/bot probability with explainable factors.
 */
export const OP_COMMAND_CHECK_ML_BEHAVIOR = "CHECK_ML_BEHAVIOR";

/** Model version reported in behavioral Sybil-detection attestations. */
export const ML_BEHAVIOR_MODEL_VERSION = "v1.0-RF-IF";

/** Maximum number of historical transactions fetched for behavior analysis. */
export const ML_BEHAVIOR_TX_LIMIT = 100;

/**
 * Parse a positive integer environment variable with a fallback.
 * @throws {Error} If the configured value is not a positive integer.
 */
function parsePositiveInteger(name: string, fallback: string): number {
  const raw = process.env[name] ?? fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

/** Maximum number of blocks to scan backwards when looking for outgoing txs. */
export const ML_SCAN_MAX_BLOCKS = parsePositiveInteger(
  "ML_SCAN_MAX_BLOCKS",
  "5000",
);

/** Hard timeout (ms) for the entire behavioral analysis RPC pass. */
export const ML_SCAN_TIMEOUT_MS = parsePositiveInteger(
  "ML_SCAN_TIMEOUT_MS",
  "30000",
);

/** Concurrency used while fetching historical blocks. */
export const ML_SCAN_CONCURRENCY = parsePositiveInteger(
  "ML_SCAN_CONCURRENCY",
  "20",
);

/** Concurrency used while fetching transaction receipts. */
export const ML_RECEIPT_FETCH_CONCURRENCY = parsePositiveInteger(
  "ML_RECEIPT_FETCH_CONCURRENCY",
  "10",
);

/** Concurrency used while fetching contract code for counterparties. */
export const ML_CODE_FETCH_CONCURRENCY = parsePositiveInteger(
  "ML_CODE_FETCH_CONCURRENCY",
  "10",
);

/** Weight of the Random-Forest component in the blended bot score. */
export const ML_RF_BLEND_WEIGHT = 0.7;

/** Weight of the Isolation-Forest anomaly component in the blended bot score. */
export const ML_ANOMALY_BLEND_WEIGHT = 0.3;

/** Steepness of the final sigmoid that maps the blended score to a probability. */
export const ML_SIGMOID_STEEPNESS = 6;

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
 * Flare Data Connector (FDC) verifier base URL.
 * @dev Used by the Twitter Web2Json attestation flow. On Coston2 this is
 *      `https://coston2-verifier.flare.network`. When left empty the handler
 *      falls back to a deterministic mock so the hackathon demo works without a
 *      live FDC deployment.
 */
export const FDC_VERIFIER_URL = (process.env.FDC_VERIFIER_URL ?? "").trim();

/**
 * Bearer token for the Twitter API v2 lookup performed inside the FDC
 * Web2Json attestation. Lives only inside the TEE.
 */
export const TWITTER_BEARER_TOKEN = (process.env.TWITTER_BEARER_TOKEN ?? "").trim();

/**
 * Base URL for the Twitter v2 API. Overrideable so a mock Twitter endpoint can
 * be substituted for the hackathon.
 */
export const TWITTER_API_BASE_URL = (
  process.env.TWITTER_API_BASE_URL ?? "https://api.twitter.com/2"
).trim();

/**
 * When true, force the mock Twitter verifier even if FDC_VERIFIER_URL is set.
 * Useful for local demos and tests.
 */
export const FDC_MOCK_TWITTER =
  (process.env.FDC_MOCK_TWITTER ?? "false").toLowerCase() === "true";

/** Poll interval (ms) while waiting for the FDC Merkle proof. */
export const FDC_POLL_INTERVAL_MS = Number(process.env.FDC_POLL_INTERVAL_MS ?? "3000");

/** Maximum number of polls before giving up on the FDC proof. */
export const FDC_POLL_MAX_ATTEMPTS = Number(
  process.env.FDC_POLL_MAX_ATTEMPTS ?? "40",
);

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
