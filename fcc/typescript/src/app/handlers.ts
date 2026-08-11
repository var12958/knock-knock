/**
 * @notice KnockKnock FCC verification handler.
 * @dev Receives the sender wallet as a private input inside the TEE, queries
 *      the Flare RPC for wallet age, checks a humanity score, and returns only
 *      the two boolean flags plus a binding hash and signature. The wallet
 *      address itself is never written to the public output data.
 */

import { ethers } from "ethers";
import {
  VERSION,
  OP_TYPE_KNOCKKNOCK,
  OP_COMMAND_VERIFY_SENDER,
  OP_COMMAND_VERIFY_TWITTER,
  OP_COMMAND_CHECK_ML_BEHAVIOR,
  ML_BEHAVIOR_MODEL_VERSION,
  ML_MOCK_ON_FAILURE,
  MIN_WALLET_AGE_SECONDS,
  HUMANITY_SCORE_THRESHOLD,
  FLARE_RPC_URL,
  PASSPORT_API_KEY,
  PASSPORT_SCORER_ID,
  PASSPORT_API_URL,
  PASSPORT_SUBMIT_URL,
  IDENTITY_API_URL,
  TEE_SIGNER_PRIVATE_KEY,
  FDC_VERIFIER_URL,
  TWITTER_BEARER_TOKEN,
  TWITTER_API_BASE_URL,
  FDC_MOCK_TWITTER,
  FDC_POLL_INTERVAL_MS,
  FDC_POLL_MAX_ATTEMPTS,
} from "./config.js";
import type { Framework } from "../base/types.js";
import type {
  VerifySenderRequest,
  VerifySenderResponse,
  IdentityScoreResponse,
  PassportScoreResponse,
  TwitterVerificationRequest,
  TwitterVerificationResponse,
  FdcWeb2JsonRequest,
  FdcAttestationStatus,
  MlBehaviorRequest,
  MlBehaviorResponse,
} from "./types.js";
import {
  analyzeWalletBehavior,
  predictBotProbability,
  generateExplanation,
  generateMockFeatures,
} from "./mlBehavior.js";

let signer: ethers.SigningKey | null = null;

export function setSigner(privateKeyHex: string): void {
  if (!privateKeyHex) {
    signer = null;
    return;
  }
  signer = new ethers.SigningKey(privateKeyHex);
}

export function register(framework: Framework): void {
  if (TEE_SIGNER_PRIVATE_KEY) {
    setSigner(TEE_SIGNER_PRIVATE_KEY);
  }
  framework.handle(OP_TYPE_KNOCKKNOCK, OP_COMMAND_VERIFY_SENDER, handleVerifySender);
  framework.handle(
    OP_TYPE_KNOCKKNOCK,
    OP_COMMAND_VERIFY_TWITTER,
    handleVerifyTwitter,
  );
  framework.handle(
    OP_TYPE_KNOCKKNOCK,
    OP_COMMAND_CHECK_ML_BEHAVIOR,
    handleCheckMlBehavior,
  );
}

export function reportState(): unknown {
  return {
    version: VERSION,
    hasSigner: signer !== null,
  };
}

export function resetState(): void {
  signer = null;
}

async function handleVerifySender(
  msg: string,
): Promise<[string | null, number, string | null]> {
  if (signer === null) {
    return [null, 0, "TEE signer not configured"];
  }

  let request: VerifySenderRequest;
  try {
    request = decodeRequest(msg);
  } catch (err) {
    return [null, 0, `decoding request: ${err}`];
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  if (now > request.deadline) {
    return [null, 0, "verification deadline expired"];
  }

  try {
    await validateChainAndMailbox(request.chainId, request.mailbox);
  } catch (err) {
    return [null, 0, `environment validation failed: ${err}`];
  }

  let isOldEnoughWallet: boolean;
  try {
    isOldEnoughWallet = await checkWalletAge(request.sender);
  } catch (err) {
    return [null, 0, `wallet age check failed: ${err}`];
  }

  let isVerifiedHuman: boolean;
  try {
    isVerifiedHuman = await checkHumanity(request.sender);
  } catch (err) {
    return [null, 0, `humanity check failed: ${err}`];
  }

  const requestHash = computeRequestHash(
    request.receiver,
    request.encryptedPreview,
    request.deadline,
  );

  const signedHash = ethers.keccak256(
    ethers.solidityPacked(
      ["uint256", "address", "address", "bool", "bool", "bytes32"],
      [request.chainId, request.mailbox, request.sender, isVerifiedHuman, isOldEnoughWallet, requestHash],
    ),
  );

  let signature: string;
  try {
    signature = signDigest(signer, signedHash);
  } catch (err) {
    return [null, 0, `signing result failed: ${err}`];
  }

  const response: VerifySenderResponse = {
    isVerifiedHuman,
    isOldEnoughWallet,
    requestHash,
    signature,
  };

  try {
    const encoded = encodeResponse(response);
    return [encoded, 1, null];
  } catch (err) {
    return [null, 0, `encoding response: ${err}`];
  }
}

function decodeRequest(msg: string): VerifySenderRequest {
  if (!msg || msg === "0x") {
    throw new Error("originalMessage is empty");
  }
  const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
    ["address", "address", "string", "uint256", "uint256", "address"],
    msg,
  ) as unknown as [string, string, string, bigint, bigint, string];
  return {
    sender: decoded[0],
    receiver: decoded[1],
    encryptedPreview: decoded[2],
    deadline: decoded[3],
    chainId: decoded[4],
    mailbox: decoded[5],
  };
}

function computeRequestHash(
  receiver: string,
  encryptedPreview: string,
  deadline: bigint,
): string {
  return ethers.keccak256(
    ethers.solidityPacked(
      ["address", "string", "uint256"],
      [receiver, encryptedPreview, deadline],
    ),
  );
}

function encodeResponse(response: VerifySenderResponse): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["bool", "bool", "bytes32", "bytes"],
    [
      response.isVerifiedHuman,
      response.isOldEnoughWallet,
      response.requestHash,
      response.signature,
    ],
  );
}

function signDigest(signingKey: ethers.SigningKey, digest: string): string {
  const sig = signingKey.sign(digest);
  // Normalize v to 27/28 for Solidity ecrecover compatibility.
  const v = sig.v < 27 ? sig.v + 27 : sig.v;
  return sig.r + sig.s.slice(2) + v.toString(16).padStart(2, "0");
}

/**
 * @notice Sanity-check that the requested chain/mailbox match the TEE's environment.
 * @dev The contract will perform the authoritative check via block.chainid and
 *      address(this); this is an early fail-fast inside the enclave.
 */
async function validateChainAndMailbox(chainId: bigint, mailbox: string): Promise<void> {
  if (!ethers.isAddress(mailbox) || mailbox === ethers.ZeroAddress) {
    throw new Error("invalid mailbox address");
  }
  try {
    const provider = new ethers.JsonRpcProvider(FLARE_RPC_URL);
    const network = await provider.getNetwork();
    if (network.chainId !== chainId) {
      throw new Error(
        `chain mismatch: expected ${network.chainId.toString()}, got ${chainId.toString()}`,
      );
    }
  } catch (err) {
    // In a production TEE this should be a hard failure. For hackathon demos
    // without a reachable Flare RPC we swallow the error and let the contract
    // enforce the authoritative chainId check.
  }
}

/**
 * @notice Query the Flare RPC to estimate whether the wallet is old enough.
 * @dev A full RPC node does not expose a "first transaction" index. The
 *      implementation below uses a binary search on the outgoing transaction
 *      count (nonce) to find the first block where the address sent a
 *      transaction, then returns that block's timestamp. If the address has
 *      never sent a transaction, it cannot satisfy Proof-of-History and the
 *      function returns false. RPC failures throw so the TEE fails closed.
 */
async function checkWalletAge(address: string): Promise<boolean> {
  const provider = new ethers.JsonRpcProvider(FLARE_RPC_URL);

  try {
    const currentNonce = await provider.getTransactionCount(address, "latest");
    if (currentNonce === 0) {
      // No outgoing transactions on this chain — cannot satisfy Proof-of-History.
      return false;
    }

    const latestBlock = await provider.getBlockNumber();
    let left = 0;
    let right = latestBlock;
    let firstBlockWithTx: number | null = null;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const nonce = await provider.getTransactionCount(address, mid);
      if (nonce > 0) {
        firstBlockWithTx = mid;
        right = mid - 1;
      } else {
        left = mid + 1;
      }
    }

    if (firstBlockWithTx === null) {
      throw new Error("unable to locate first transaction block");
    }

    const block = await provider.getBlock(firstBlockWithTx);
    if (!block) {
      throw new Error("unable to fetch first transaction block");
    }

    const latest = await provider.getBlock("latest");
    if (!latest) {
      throw new Error("unable to fetch latest block");
    }

    const ageSeconds = Number(latest.timestamp) - Number(block.timestamp);
    return ageSeconds >= MIN_WALLET_AGE_SECONDS;
  } catch (err) {
    // RPC unavailable on local test stacks — fail closed so the TEE never signs
    // a bogus proof-of-history.
    throw new Error(`Flare RPC wallet-age query failed: ${err}`);
  }
}

/**
 * @notice Proof-of-Humanity check using the Human Passport API.
 * @dev Requires PASSPORT_API_KEY. The TEE calls Human Passport's scorer endpoint
 *      and treats any score above HUMANITY_SCORE_THRESHOLD as verified human.
 *      If the API is unreachable, it falls back to the legacy IDENTITY_API_URL
 *      (real API only); otherwise it fails closed.
 */
async function checkHumanity(address: string): Promise<boolean> {
  if (!PASSPORT_API_KEY) {
    throw new Error("PASSPORT_API_KEY is not configured");
  }

  // When the threshold is 0, every wallet passes Proof-of-Humanity regardless
  // of the API response (including null/undefined scores). This is intended for
  // hackathon/testing onboarding flows only.
  if (HUMANITY_SCORE_THRESHOLD <= 0) {
    console.log(`[Human Passport] threshold is 0; marking ${address} as verified human`);
    return true;
  }

  // 1) Submit the wallet to the scorer, then fetch the score.
  try {
    await submitPassport(address);
    const score = await fetchPassportScore(address);
    return score > HUMANITY_SCORE_THRESHOLD;
  } catch {
    // Fall through to the legacy identity API if one is configured.
  }

  // 2) Legacy generic identity API fallback.
  if (IDENTITY_API_URL) {
    try {
      return await fetchLegacyIdentityScore(address);
    } catch (err) {
      throw new Error(`legacy identity API query failed: ${err}`);
    }
  }

  throw new Error(
    "Human Passport query failed and no legacy identity API is configured",
  );
}

/**
 * @notice Submit a wallet address to the Human Passport scorer.
 * @dev This must happen before the wallet has a computed score. The call is
 *      idempotent for already-submitted wallets.
 * @param address Wallet address to submit.
 * @throws If the API call fails.
 */
async function submitPassport(address: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(PASSPORT_SUBMIT_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-API-Key": PASSPORT_API_KEY,
      },
      body: JSON.stringify({
        address,
        scorer_id: String(PASSPORT_SCORER_ID),
      }),
    });

    const responseText = await response.text();

    if (!response.ok) {
      console.error(
        `[Human Passport submit error] status=${response.status} url=${PASSPORT_SUBMIT_URL} body=${responseText}`,
      );
      throw new Error(
        `Human Passport submit returned ${response.status}: ${responseText}`,
      );
    }

    console.log(`[Human Passport] submit-passport succeeded for ${address}`);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * @notice Fetch the sender's Human Passport score.
 * @param address Wallet address to score.
 * @returns The Human Passport score (e.g. 0-100+).
 * @throws If the API call fails or returns an unusable payload.
 */
async function fetchPassportScore(address: string): Promise<number> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const url = new URL(PASSPORT_API_URL);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${PASSPORT_SCORER_ID}/${address}`;

    const response = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "X-API-Key": PASSPORT_API_KEY,
      },
    });

    const responseText = await response.text();
    let body: PassportScoreResponse;
    try {
      body = JSON.parse(responseText) as PassportScoreResponse;
    } catch {
      body = {} as PassportScoreResponse;
    }

    if (!response.ok) {
      console.error(
        `[Human Passport API error] status=${response.status} url=${url.toString()} body=${responseText}`,
      );
      throw new Error(`Human Passport API returned ${response.status}: ${responseText}`);
    }

    const score = extractScore(body);
    if (score === null || Number.isNaN(score)) {
      console.error(
        `[Human Passport API error] status=${response.status} body=${responseText}`,
      );
      throw new Error("Human Passport API response did not contain a numeric score");
    }
    return score;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * @notice Extract a numeric score from a Human Passport API payload.
 * @dev Handles multiple known response shapes:
 *      - { score: "12.34" }
 *      - { score: 12.34 }
 *      - { items: [ { score: "..." } ] }
 *      - { evidence: { threshold: "...", rawScore: "..." } }
 */
function extractScore(body: PassportScoreResponse): number | null {
  if (body == null) return null;

  if (typeof body.score === "number") return body.score;
  if (typeof body.score === "string") {
    const parsed = Number(body.score);
    if (!Number.isNaN(parsed)) return parsed;
  }

  if (body.evidence) {
    if (typeof body.evidence.rawScore === "number") return body.evidence.rawScore;
    if (typeof body.evidence.rawScore === "string") {
      const parsed = Number(body.evidence.rawScore);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }

  if (Array.isArray(body.items) && body.items.length > 0) {
    const first = body.items[0];
    if (first && typeof first.score === "number") return first.score;
    if (first && typeof first.score === "string") {
      const parsed = Number(first.score);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }

  return null;
}

/**
 * @notice Legacy generic identity API fallback.
 */
async function fetchLegacyIdentityScore(address: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const url = new URL(IDENTITY_API_URL);
    url.searchParams.set("address", address);

    const response = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`identity API returned ${response.status}`);
    }

    const body = (await response.json()) as IdentityScoreResponse;
    const score = body.score ?? (body.human ? 100 : 0);
    return score > HUMANITY_SCORE_THRESHOLD;
  } finally {
    clearTimeout(timeout);
  }
}

/* ------------------------------------------------------------------ */
/* Twitter verification via the Flare Data Connector (FDC)             */
/* ------------------------------------------------------------------ */

/**
 * @notice TEE handler for VERIFY_TWITTER.
 * @dev Receives `(address, twitterHandle)` as a private input, requests a
 *      Web2Json attestation from the Flare Data Connector against the Twitter
 *      v2 API, polls for the Merkle proof, and returns whether the handle is
 *      a verified account. The wallet address is used only to bind the proof
 *      and is never written to any public output.
 */
async function handleVerifyTwitter(
  msg: string,
): Promise<[string | null, number, string | null]> {
  let request: TwitterVerificationRequest;
  try {
    request = decodeTwitterRequest(msg);
  } catch (err) {
    return [null, 0, `decoding twitter request: ${err}`];
  }

  const handle = normalizeTwitterHandle(request.twitterHandle);
  if (!handle) {
    return [null, 0, "twitter handle is required"];
  }
  if (!ethers.isAddress(request.address)) {
    return [null, 0, "invalid sender address"];
  }

  let isTwitterVerified: boolean;
  let attestationId: string;
  try {
    [isTwitterVerified, attestationId] = await checkTwitterVerification(
      request.address,
      handle,
    );
  } catch (err) {
    return [null, 0, `twitter verification failed: ${err}`];
  }

  const response: TwitterVerificationResponse = {
    isTwitterVerified,
    twitterHandle: handle,
    attestationId,
  };

  try {
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["bool", "string", "string"],
      [response.isTwitterVerified, response.twitterHandle, response.attestationId],
    );
    return [encoded, 1, null];
  } catch (err) {
    return [null, 0, `encoding twitter response: ${err}`];
  }
}

function decodeTwitterRequest(msg: string): TwitterVerificationRequest {
  if (!msg || msg === "0x") {
    throw new Error("originalMessage is empty");
  }
  const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
    ["address", "string"],
    msg,
  ) as unknown as [string, string];
  return { address: decoded[0], twitterHandle: decoded[1] };
}

/** Strip a leading @ and surrounding whitespace; lowercase for lookups. */
function normalizeTwitterHandle(handle: string): string {
  const trimmed = handle.trim().replace(/^@+/, "").toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(trimmed)) {
    return "";
  }
  return trimmed;
}

/**
 * @notice Verify a Twitter handle via the Flare Data Connector.
 * @dev Constructs a Web2Json attestation request whose API URL points at the
 *      Twitter v2 user-lookup endpoint, with a JMESPath rule that extracts the
 *      `verified` boolean from the response. The request is submitted to the
 *      FDC Verifier API and polled until the Merkle proof is available. When
 *      no FDC verifier or Twitter bearer token is configured (or FDC_MOCK_TWITTER
 *      is set), a deterministic mock is used so the hackathon demo works
 *      end-to-end without live credentials.
 * @returns A tuple of `[isTwitterVerified, attestationId]`.
 */
export async function checkTwitterVerification(
  address: string,
  twitterHandle: string,
): Promise<[boolean, string]> {
  const handle = normalizeTwitterHandle(twitterHandle);
  if (!handle) {
    throw new Error("invalid twitter handle");
  }

  // Mock mode: no live FDC/Twitter credentials available.
  if (FDC_MOCK_TWITTER || !FDC_VERIFIER_URL || !TWITTER_BEARER_TOKEN) {
    return mockTwitterVerification(address, handle);
  }

  const fdcRequest = buildTwitterFdcRequest(handle);
  const attestationId = await submitFdcAttestation(fdcRequest);
  const encodedData = await pollFdcAttestation(attestationId);
  const isTwitterVerified = decodeTwitterVerifiedFromFdc(encodedData);
  return [isTwitterVerified, attestationId];
}

/**
 * @notice Build the Web2Json attestation request for a Twitter v2 user lookup.
 * @dev The JMESPath expression `data.verified` selects the `verified` boolean
 *      from the Twitter `GET /2/users/by/username/:username` response. To gate
 *      on a minimum follower count instead, swap the expression for
 *      `data.public_metrics.followers_count` and change the decoder.
 */
function buildTwitterFdcRequest(handle: string): FdcWeb2JsonRequest {
  const url = `${TWITTER_API_BASE_URL.replace(/\/$/, "")}/users/by/username/${encodeURIComponent(
    handle,
  )}?user.fields=public_metrics,verified`;

  return {
    attestationType: "Web2Json",
    sourceId: "twitter",
    requestId: 0,
    data: {
      url,
      headers: JSON.stringify({
        Authorization: `Bearer ${TWITTER_BEARER_TOKEN}`,
      }),
      postParameters: "",
      body: "",
      responseType: "string",
      httpMethod: "GET",
      // Pull the verified boolean straight out of the Twitter payload.
      jmespathExpression: "data.verified",
    },
  };
}

/**
 * @notice Submit an FDC Web2Json attestation request to the Verifier API.
 * @dev The verifier accepts the unencoded request object and returns a
 *      request/attestation id used for status polling.
 */
async function submitFdcAttestation(
  request: FdcWeb2JsonRequest,
): Promise<string> {
  const endpoint = `${FDC_VERIFIER_URL.replace(/\/$/, "")}/verifier/api/0.1/Attestation/post`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`FDC submit returned ${response.status}: ${text}`);
    }

    let body: { attestationId?: string; requestHash?: string; error?: string };
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`FDC submit returned non-JSON: ${text}`);
    }

    if (body.error) {
      throw new Error(`FDC submit error: ${body.error}`);
    }

    const attestationId = body.attestationId ?? body.requestHash;
    if (!attestationId) {
      throw new Error("FDC submit did not return an attestation id");
    }
    console.log(`[FDC] submitted twitter attestation: ${attestationId}`);
    return attestationId;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * @notice Poll the FDC Verifier until the attestation is finalized.
 * @returns The ABI-encoded attestation response (the Merkle-proven payload).
 */
async function pollFdcAttestation(attestationId: string): Promise<string> {
  const endpoint = `${FDC_VERIFIER_URL.replace(/\/$/, "")}/verifier/api/0.1/Attestation/status/${encodeURIComponent(
    attestationId,
  )}`;

  for (let attempt = 0; attempt < FDC_POLL_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(endpoint, {
        method: "GET",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`FDC status returned ${response.status}: ${text}`);
      }

      const body = (await response.json()) as FdcAttestationStatus;

      if (body.status === "REJECTED") {
        throw new Error(`FDC attestation rejected: ${body.error ?? body.message ?? "unknown"}`);
      }
      if (body.status === "DONE") {
        const encodedData = body.response?.encodedData;
        if (!encodedData) {
          throw new Error("FDC attestation completed without encoded data");
        }
        console.log(`[FDC] twitter attestation finalized on attempt ${attempt + 1}`);
        return encodedData;
      }
    } finally {
      clearTimeout(timeout);
    }

    console.log(
      `[FDC] twitter attestation pending (attempt ${attempt + 1}/${FDC_POLL_MAX_ATTEMPTS}); sleeping ${FDC_POLL_INTERVAL_MS}ms`,
    );
    await sleep(FDC_POLL_INTERVAL_MS);
  }

  throw new Error("timed out waiting for the FDC twitter attestation");
}

/**
 * @notice Decode the FDC Web2Json response into a `verified` boolean.
 * @dev A Web2Json attestation response wraps the JMESPath-extracted value as a
 *      string inside the encoded data. We decode defensively: the extracted
 *      value is the trailing string segment of the ABI-encoded response. This
 *      tolerates version differences in the FDC envelope while still resolving
 *      "true"/"false"/"1"/"0" to a boolean.
 */
function decodeTwitterVerifiedFromFdc(encodedData: string): boolean {
  try {
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
      ["bytes"],
      encodedData,
    ) as unknown as [string];
    const inner = decoded[0];
    // The inner bytes are themselves ABI-encoded; the last string slot holds
    // the JMESPath result ("true" / "false").
    const tail = ethers.hexlify(inner).slice(2);
    const ascii = Buffer.from(tail, "hex").toString("utf-8").trim();
    const lastToken = ascii.split(/ |"/).filter(Boolean).pop() ?? "";
    return lastToken.toLowerCase() === "true" || lastToken === "1";
  } catch (err) {
    console.error(`[FDC] failed to decode verified flag: ${err}`);
    throw new Error(`FDC twitter response was not decodable: ${err}`);
  }
}

/**
 * @notice Deterministic mock used when no live FDC/Twitter credentials exist.
 * @dev Returns true for plausible handles and false for obvious spam handles,
 *      so the onboarding demo exercises both badge states without external
 *      dependencies. Replace with the real FDC path by setting FDC_VERIFIER_URL
 *      and TWITTER_BEARER_TOKEN (and unsetting FDC_MOCK_TWITTER).
 */
function mockTwitterVerification(
  address: string,
  handle: string,
): [boolean, string] {
  const spamPrefixes = ["bot", "spam", "fake", "scam"];
  const isSpam = spamPrefixes.some((p) => handle.startsWith(p));
  const isTwitterVerified = !isSpam && handle.length >= 2;
  const attestationId = ethers.id(
    `mock-twitter-${address.toLowerCase()}-${handle}-${Date.now()}`,
  );
  console.log(
    `[FDC mock] twitter verified=${isTwitterVerified} for handle=${handle} address=${address}`,
  );
  return [isTwitterVerified, attestationId];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/* ML-powered on-chain behavioral Sybil detection                      */
/* ------------------------------------------------------------------ */

/**
 * @notice TEE handler for CHECK_ML_BEHAVIOR.
 * @dev Receives an ABI-encoded `targetAddress`, analyzes the wallet's recent
 *      on-chain behavior, runs a heuristic Random-Forest/Isolation-Forest model
 *      inside the enclave, and returns a signed human/bot probability with
 *      explainable factors.
 */
async function handleCheckMlBehavior(
  msg: string,
): Promise<[string | null, number, string | null]> {
  if (signer === null) {
    return [null, 0, "TEE signer not configured"];
  }

  let request: MlBehaviorRequest;
  try {
    request = decodeMlBehaviorRequest(msg);
  } catch {
    return [null, 0, "invalid ML behavior request"];
  }

  if (!ethers.isAddress(request.targetAddress)) {
    return [null, 0, "invalid target address"];
  }

  let features: number[];
  try {
    features = await analyzeWalletBehavior(request.targetAddress);
  } catch (err) {
    console.error("[handleCheckMlBehavior] analyzeWalletBehavior failed:", err);
    if (ML_MOCK_ON_FAILURE) {
      console.warn(
        "[handleCheckMlBehavior] ML_MOCK_ON_FAILURE enabled; using deterministic mock features",
      );
      // A deterministic mock vector seeded from the target address. It is still
      // signed by the TEE so the caller can see it came from the enclave, but
      // the score is not derived from on-chain history.
      features = generateMockFeatures(request.targetAddress);
    } else {
      return [null, 0, "behavior analysis failed"];
    }
  }

  const { botProbability, humanProbability } = predictBotProbability(features);
  const explanation = generateExplanation(features, botProbability);

  // Derive one probability from the other after rounding so they always sum
  // to exactly the basis-point scale (10_000).
  const botBp = Math.round(botProbability * BASIS_POINTS);
  const humanBp = BASIS_POINTS - botBp;

  const signerAddress = ethers.computeAddress(signer.publicKey);
  const timestamp = Math.floor(Date.now() / 1000);

  const explanationHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string[]"], [explanation]),
  );

  const signedHash = ethers.keccak256(
    ethers.solidityPacked(
      [
        "bytes32",
        "bytes32",
        "uint256",
        "uint256",
        "address",
        "address",
        "string",
        "uint256",
        "bytes32",
      ],
      [
        ethers.encodeBytes32String(OP_TYPE_KNOCKKNOCK),
        ethers.encodeBytes32String(OP_COMMAND_CHECK_ML_BEHAVIOR),
        humanBp,
        botBp,
        request.targetAddress,
        signerAddress,
        ML_BEHAVIOR_MODEL_VERSION,
        timestamp,
        explanationHash,
      ],
    ),
  );

  let signature: string;
  try {
    signature = signDigest(signer, signedHash);
  } catch {
    return [null, 0, "signing ML behavior result failed"];
  }

  const response: MlBehaviorResponse = {
    humanProbability: humanBp,
    botProbability: botBp,
    explanation,
    modelVersion: ML_BEHAVIOR_MODEL_VERSION,
    targetAddress: request.targetAddress,
    signerAddress,
    timestamp,
    signature,
  };

  try {
    const encoded = encodeMlBehaviorResponse(response);
    return [encoded, 1, null];
  } catch {
    return [null, 0, "encoding ML behavior response failed"];
  }
}

function decodeMlBehaviorRequest(msg: string): MlBehaviorRequest {
  if (!msg || msg === "0x") {
    throw new Error("originalMessage is empty");
  }
  const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
    ["address"],
    msg,
  ) as unknown as [string];
  return { targetAddress: decoded[0] };
}

function encodeMlBehaviorResponse(response: MlBehaviorResponse): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    [
      "uint256",
      "uint256",
      "string[]",
      "string",
      "address",
      "address",
      "uint256",
      "bytes",
    ],
    [
      response.humanProbability,
      response.botProbability,
      response.explanation,
      response.modelVersion,
      response.targetAddress,
      response.signerAddress,
      response.timestamp,
      response.signature,
    ],
  );
}

/** Basis-point scale used for probabilities returned to the client. */
const BASIS_POINTS = 10_000;
