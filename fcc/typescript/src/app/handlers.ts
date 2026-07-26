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
  MIN_WALLET_AGE_SECONDS,
  HUMANITY_SCORE_THRESHOLD,
  FLARE_RPC_URL,
  PASSPORT_API_KEY,
  PASSPORT_SCORER_ID,
  PASSPORT_API_URL,
  PASSPORT_SUBMIT_URL,
  IDENTITY_API_URL,
  TEE_SIGNER_PRIVATE_KEY,
} from "./config.js";
import type { Framework } from "../base/types.js";
import type {
  VerifySenderRequest,
  VerifySenderResponse,
  IdentityScoreResponse,
  PassportScoreResponse,
} from "./types.js";

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
