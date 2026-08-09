/**
 * @notice KnockKnock Firebase Cloud Functions.
 * @dev Provides a secure backend for operations that Firebase RTDB rules alone
 *      cannot enforce, such as verifying an on-chain mailbox transaction and
 *      writing the resulting verified status to a user's profile.
 */

import { initializeApp, getApps } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { defineString } from "firebase-functions/params";
import { ethers } from "ethers";
import { MAILBOX_ABI } from "./mailboxAbi.js";

// Initialize Firebase Admin if it has not already been initialized by the runtime.
if (getApps().length === 0) {
  initializeApp();
}

const db = getDatabase();

const rpcUrl = defineString("FLARE_RPC_URL", {
  default: "https://coston2-api.flare.network/ext/C/rpc",
});

const mailboxAddress = defineString("MAILBOX_ADDRESS", {
  default: "",
});

// --- Twitter verification via the Flare Data Connector (FDC) ---
// When FDC_VERIFIER_URL is empty (or FDC_MOCK_TWITTER is true) the function
// uses a deterministic mock so the hackathon demo works without live FDC +
// Twitter credentials. The mock runs entirely server-side, so the client
// cannot influence its result; only the persisted flag is non-authoritative.
const fdcVerifierUrl = defineString("FDC_VERIFIER_URL", { default: "" });
const twitterBearerToken = defineString("TWITTER_BEARER_TOKEN", { default: "" });
const twitterApiBaseUrl = defineString("TWITTER_API_BASE_URL", {
  default: "https://api.twitter.com/2",
});
const fdcMockTwitter = defineString("FDC_MOCK_TWITTER", { default: "true" });
const fdcPollIntervalMs = defineString("FDC_POLL_INTERVAL_MS", { default: "3000" });
const fdcPollMaxAttempts = defineString("FDC_POLL_MAX_ATTEMPTS", { default: "40" });

const TWITTER_HANDLE_REGEX = /^[a-z0-9_]{1,15}$/;

const USERNAME_MIN_LENGTH = 3;
const USERNAME_MAX_LENGTH = 24;
const USERNAME_REGEX = /^[a-zA-Z0-9_-]+$/;

interface UserProfile {
  uid?: string;
  username?: string;
  email?: string | null;
  displayName?: string | null;
  walletAddress?: string | null;
  isVerifiedHuman?: boolean;
  isOldEnoughWallet?: boolean;
  verificationTxHash?: string | null;
  verifiedAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
}

interface RequestSentEvent {
  requestId: bigint;
  sender: string;
  receiver: string;
}

interface TransactionData {
  users?: Record<string, UserProfile>;
  usernames?: Record<string, { uid?: string; reservedAt?: number }>;
  walletAddresses?: Record<string, { uid?: string; linkedAt?: number }>;
}

function getConfiguredMailboxAddress(): string {
  const address = mailboxAddress.value();
  if (!address || !ethers.isAddress(address) || address === ethers.ZeroAddress) {
    throw new HttpsError("failed-precondition", "Mailbox address is not configured.");
  }
  return address;
}

function getProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(rpcUrl.value());
}

function getMailboxInterface(): ethers.Interface {
  return new ethers.Interface(MAILBOX_ABI);
}

async function fetchReceipt(txHash: string): Promise<ethers.TransactionReceipt> {
  if (!txHash || typeof txHash !== "string" || !/^0x([A-Fa-f0-9]{64})$/.test(txHash)) {
    throw new HttpsError("invalid-argument", "A valid transaction hash is required.");
  }

  const provider = getProvider();
  let receipt: ethers.TransactionReceipt | null;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch (err) {
    console.error("RPC error fetching receipt:", err);
    throw new HttpsError("internal", "Unable to verify transaction on-chain.");
  }

  if (!receipt) {
    throw new HttpsError("not-found", "Transaction receipt not found.");
  }

  return receipt;
}

function parseRequestSent(receipt: ethers.TransactionReceipt): RequestSentEvent {
  const address = getConfiguredMailboxAddress();

  console.log(
    `[verifyFCCOnboarding] configured MAILBOX_ADDRESS=${address.toLowerCase()}`,
  );
  console.log(
    `[verifyFCCOnboarding] transaction receipt to=${receipt.to?.toLowerCase() ?? "(missing)"}`,
  );

  if (receipt.to?.toLowerCase() !== address.toLowerCase()) {
    throw new HttpsError(
      "invalid-argument",
      "Transaction was not sent to the KnockKnockMailbox contract.",
    );
  }

  if (receipt.status !== 1) {
    throw new HttpsError("invalid-argument", "Mailbox transaction failed on-chain.");
  }

  const iface = getMailboxInterface();
  const requestSentTopic = iface.getEvent("RequestSent")?.topicHash;
  const requestLog = receipt.logs.find(
    (log) =>
      log.address.toLowerCase() === address.toLowerCase() &&
      log.topics[0] === requestSentTopic,
  );

  if (!requestLog) {
    throw new HttpsError(
      "invalid-argument",
      "No RequestSent event found in the mailbox transaction.",
    );
  }

  let parsedLog: ethers.LogDescription;
  try {
    parsedLog = iface.parseLog(requestLog) as ethers.LogDescription;
  } catch (err) {
    console.error("Failed to parse RequestSent log:", err);
    throw new HttpsError("internal", "Failed to parse mailbox event.");
  }

  return {
    requestId: parsedLog.args.requestId as bigint,
    sender: parsedLog.args.sender as string,
    receiver: parsedLog.args.receiver as string,
  };
}

async function loadProfile(uid: string): Promise<UserProfile> {
  const snapshot = await db.ref(`users/${uid}`).get();
  if (!snapshot.exists()) {
    throw new HttpsError("not-found", "User profile not found.");
  }
  return snapshot.val() as UserProfile;
}

export function assertProfileWalletMatches(profile: UserProfile, walletAddress: string): void {
  const linked = profile.walletAddress;
  if (!linked || !ethers.isAddress(linked)) {
    throw new HttpsError(
      "failed-precondition",
      "No wallet address linked to this profile. Connect your wallet first.",
    );
  }
  if (linked.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new HttpsError(
      "permission-denied",
      "Transaction sender does not match the linked wallet address.",
    );
  }
}

export function normalizeUsername(username: string): string {
  return username
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function validateUsername(username: string): void {
  const trimmed = username.trim();
  if (
    trimmed.length < USERNAME_MIN_LENGTH ||
    trimmed.length > USERNAME_MAX_LENGTH
  ) {
    throw new HttpsError(
      "invalid-argument",
      `Username must be between ${USERNAME_MIN_LENGTH} and ${USERNAME_MAX_LENGTH} characters.`,
    );
  }
  if (!USERNAME_REGEX.test(trimmed)) {
    throw new HttpsError(
      "invalid-argument",
      "Username can only contain letters, numbers, underscores, and dashes.",
    );
  }
}

export interface ReserveUsernameData {
  username: string;
}

export interface ReserveUsernameResult {
  success: boolean;
  username: string;
}

/**
 * Atomically reserve a username and create the initial user profile.
 *
 * Centralizing this in a Cloud Function prevents:
 *   - Username-squatting (one UID can only create one profile).
 *   - Race conditions between availability checks and reservations.
 *   - Stale reservations if profile creation fails.
 */
function buildReserveUpdate(
  currentData: TransactionData | null,
  uid: string,
  username: string,
  encodedUsername: string,
  email: string | null,
  displayName: string | null,
  now: number,
): TransactionData | undefined {
  if (currentData?.users?.[uid] || currentData?.usernames?.[encodedUsername]) {
    return undefined;
  }

  const nextData: TransactionData = JSON.parse(JSON.stringify(currentData ?? {}));
  nextData.users = nextData.users ?? {};
  nextData.usernames = nextData.usernames ?? {};
  nextData.users[uid] = {
    uid,
    username,
    email,
    displayName,
    createdAt: now,
    updatedAt: now,
  };
  nextData.usernames[encodedUsername] = {
    uid,
    reservedAt: now,
  };

  return nextData;
}

export async function reserveUsernameAndCreateProfileHandler(
  request: CallableRequest<ReserveUsernameData>,
): Promise<ReserveUsernameResult> {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be signed in.");
  }

  const uid = request.auth.uid;
  const username = request.data.username;

  validateUsername(username);
  const encodedUsername = normalizeUsername(username);
  if (!encodedUsername) {
    throw new HttpsError("invalid-argument", "Username is invalid after normalization.");
  }

  const token = request.auth.token;
  const email = (token.email as string | undefined) ?? null;
  const displayName = (token.name as string | undefined) ?? null;
  const now = Date.now();

  try {
    const { committed } = await db.ref().transaction((currentData) =>
      buildReserveUpdate(currentData, uid, username, encodedUsername, email, displayName, now),
    );
    if (!committed) {
      throw new HttpsError("already-exists", "That username is already taken or you already have a profile.");
    }
  } catch (err: any) {
    if (err instanceof HttpsError) {
      throw err;
    }
    console.error("Failed to reserve username and create profile:", err);
    throw new HttpsError("internal", "Could not save profile. Please try again.");
  }

  return { success: true, username };
}

export const reserveUsernameAndCreateProfile = onCall<ReserveUsernameData>(
  {
    region: "us-central1",
    minInstances: 0,
    maxInstances: 10,
    memory: "256MiB",
    timeoutSeconds: 30,
    secrets: [],
  },
  reserveUsernameAndCreateProfileHandler,
);

export interface LinkWalletData {
  walletAddress: string;
  signature: string;
}

export interface LinkWalletResult {
  success: boolean;
  walletAddress: string;
}

/**
 * Link a Flare wallet address to the authenticated user's profile.
 *
 * Security invariants enforced:
 *   - Caller must be authenticated.
 *   - A signature proves ownership of the wallet address.
 *   - Each wallet address can only be linked to one profile.
 *   - Each profile can only have one linked wallet address.
 */
function buildLinkUpdate(
  currentData: TransactionData | null,
  uid: string,
  normalizedAddress: string,
  walletAddress: string,
  now: number,
): TransactionData | undefined {
  const profileWallet = currentData?.users?.[uid]?.walletAddress;
  const existingLink = currentData?.walletAddresses?.[normalizedAddress];

  if (profileWallet || (existingLink && existingLink.uid !== uid)) {
    return undefined;
  }

  const nextData: TransactionData = JSON.parse(JSON.stringify(currentData ?? {}));
  nextData.users = nextData.users ?? {};
  nextData.walletAddresses = nextData.walletAddresses ?? {};
  nextData.users[uid] = nextData.users[uid] ?? {};
  nextData.users[uid].walletAddress = walletAddress;
  nextData.users[uid].updatedAt = now;
  nextData.walletAddresses[normalizedAddress] = {
    uid,
    linkedAt: now,
  };

  return nextData;
}

export async function linkWalletHandler(
  request: CallableRequest<LinkWalletData>,
): Promise<LinkWalletResult> {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be signed in.");
  }

  const uid = request.auth.uid;
  const walletAddress = request.data.walletAddress;
  const signature = request.data.signature;

  if (!walletAddress || !ethers.isAddress(walletAddress)) {
    throw new HttpsError("invalid-argument", "A valid wallet address is required.");
  }
  if (!signature || typeof signature !== "string" || !signature.startsWith("0x")) {
    throw new HttpsError("invalid-argument", "A valid signature is required.");
  }

  const normalizedAddress = walletAddress.toLowerCase();
  const message = `Link wallet ${normalizedAddress} to KnockKnock account ${uid}`;

  let recoveredAddress: string;
  try {
    recoveredAddress = ethers.verifyMessage(message, signature);
  } catch (err) {
    console.error("Signature verification failed:", err);
    throw new HttpsError("invalid-argument", "Invalid wallet signature.");
  }

  if (recoveredAddress.toLowerCase() !== normalizedAddress) {
    throw new HttpsError("permission-denied", "Signature does not match the wallet address.");
  }

  const now = Date.now();

  try {
    const { committed } = await db.ref().transaction((currentData) =>
      buildLinkUpdate(currentData, uid, normalizedAddress, walletAddress, now),
    );
    if (!committed) {
      throw new HttpsError("already-exists", "This wallet is already linked to another account or your profile already has a wallet.");
    }
  } catch (err: any) {
    if (err instanceof HttpsError) {
      throw err;
    }
    console.error("Failed to link wallet:", err);
    throw new HttpsError("internal", "Could not link wallet. Please try again.");
  }

  return { success: true, walletAddress };
}

export const linkWallet = onCall<LinkWalletData>(
  {
    region: "us-central1",
    minInstances: 0,
    maxInstances: 10,
    memory: "256MiB",
    timeoutSeconds: 30,
    secrets: [],
  },
  linkWalletHandler,
);

export interface PublishChatRequestData {
  txHash: string;
}

export interface PublishChatRequestResult {
  success: boolean;
  requestId: string;
  receiverUid?: string;
}

/**
 * Publish a chat request record in Firebase after a successful mailbox transaction.
 *
 * This bridges on-chain mailbox state with Firebase chat storage so that RTDB
 * rules can restrict chat access to the two participants.
 */
export async function publishChatRequestHandler(
  request: CallableRequest<PublishChatRequestData>,
): Promise<PublishChatRequestResult> {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be signed in.");
  }

  const uid = request.auth.uid;
  const txHash = request.data.txHash;

  const profile = await loadProfile(uid);

  const receipt = await fetchReceipt(txHash);
  const event = parseRequestSent(receipt);
  assertProfileWalletMatches(profile, event.sender);

  // Resolve the receiver's UID from the wallet-address index if the receiver has
  // already linked a wallet. A knock can be sent to any valid wallet, even if
  // the receiver has not onboarded yet; the request metadata is persisted under
  // their address so it is ready when they do log in.
  const receiverAddress = event.receiver.toLowerCase();
  const receiverSnapshot = await db.ref(`walletAddresses/${receiverAddress}`).get();
  let receiverUid: string | undefined;
  if (receiverSnapshot.exists()) {
    receiverUid = (receiverSnapshot.val() as { uid?: string }).uid ?? undefined;
  }

  const requestId = event.requestId.toString();
  const now = Date.now();
  const requestRef = db.ref(`requests/${requestId}`);

  const existing = await requestRef.get();
  if (existing.exists()) {
    const existingData = existing.val() as {
      senderUid?: string;
      receiverUid?: string;
    };
    if (existingData.senderUid !== uid) {
      throw new HttpsError(
        "already-exists",
        "Chat request already exists with different participants.",
      );
    }

    // If the receiver has since linked a wallet, backfill their UID so the
    // request becomes readable by them. This keeps the function idempotent for
    // the same txHash while supporting knocks sent before the receiver onboarded.
    if (receiverUid && existingData.receiverUid !== receiverUid) {
      await requestRef.child("receiverUid").set(receiverUid);
    }

    return { success: true, requestId, receiverUid };
  }

  const requestData: Record<string, unknown> = {
    senderUid: uid,
    senderAddress: event.sender,
    receiverAddress: event.receiver,
    createdAt: now,
  };
  if (receiverUid) {
    requestData.receiverUid = receiverUid;
  }

  await requestRef.set(requestData);

  return { success: true, requestId, receiverUid };
}

export const publishChatRequest = onCall<PublishChatRequestData>(
  {
    region: "us-central1",
    minInstances: 0,
    maxInstances: 10,
    memory: "256MiB",
    timeoutSeconds: 30,
    secrets: [],
  },
  publishChatRequestHandler,
);

export interface VerifyFCCOnboardingData {
  txHash: string;
}

export interface VerifyFCCOnboardingResult {
  success: boolean;
  isVerifiedHuman: boolean;
  isOldEnoughWallet: boolean;
}

/**
 * Verifies that an onboarding FCC proof transaction was mined successfully and
 * writes the attested flags to the authenticated user's profile.
 *
 * Security invariants enforced:
 *   - Caller must be authenticated.
 *   - The transaction must be to the configured KnockKnockMailbox address.
 *   - The transaction must have succeeded (status === 1).
 *   - The RequestSent event sender must match the walletAddress stored in the
 *     user's profile.
 *   - The request struct returned by the mailbox contract must show the flags
 *     the TEE attested to.
 */
export async function verifyFCCOnboardingHandler(
  request: CallableRequest<VerifyFCCOnboardingData>,
): Promise<VerifyFCCOnboardingResult> {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be signed in.");
  }

  const uid = request.auth.uid;
  const txHash = request.data.txHash;

  const address = getConfiguredMailboxAddress();
  const profile = await loadProfile(uid);

  const receipt = await fetchReceipt(txHash);
  const event = parseRequestSent(receipt);
  assertProfileWalletMatches(profile, event.sender);

  // Read the request struct from the contract to get the TEE-attested flags.
  const provider = getProvider();
  const mailbox = new ethers.Contract(address, MAILBOX_ABI, provider);

  let requestStruct: {
    sender: string;
    receiver: string;
    encryptedPreviewMessage: string;
    isVerifiedHuman: boolean;
    isOldEnoughWallet: boolean;
    accepted: boolean;
    isRevealed: boolean;
    expirationTime: bigint;
  };
  try {
    requestStruct = (await mailbox.requests(event.requestId)) as typeof requestStruct;
  } catch (err) {
    console.error("RPC error reading request struct:", err);
    throw new HttpsError("internal", "Unable to read request details from the mailbox.");
  }

  if (requestStruct.sender.toLowerCase() !== event.sender.toLowerCase()) {
    throw new HttpsError(
      "permission-denied",
      "Request sender does not match the linked wallet address.",
    );
  }

  // Persist the verified flags using the Admin SDK.
  const now = Date.now();
  await db.ref(`users/${uid}`).update({
    isVerifiedHuman: Boolean(requestStruct.isVerifiedHuman),
    isOldEnoughWallet: Boolean(requestStruct.isOldEnoughWallet),
    verificationTxHash: txHash,
    verifiedAt: now,
    updatedAt: now,
  });

  return {
    success: true,
    isVerifiedHuman: Boolean(requestStruct.isVerifiedHuman),
    isOldEnoughWallet: Boolean(requestStruct.isOldEnoughWallet),
  };
}

export const verifyFCCOnboarding = onCall<VerifyFCCOnboardingData>(
  {
    region: "us-central1",
    minInstances: 0,
    maxInstances: 10,
    memory: "256MiB",
    timeoutSeconds: 30,
    secrets: [],
  },
  verifyFCCOnboardingHandler,
);

export interface SwitchLinkedWalletData {
  walletAddress: string;
  signature: string;
  txHash: string;
}

export interface SwitchLinkedWalletResult {
  success: boolean;
  walletAddress: string;
  isVerifiedHuman: boolean;
  isOldEnoughWallet: boolean;
}

/**
 * Switch the wallet linked to an already-verified profile.
 *
 * Security invariants enforced:
 *   - Caller must be authenticated.
 *   - The profile must already be verified (this is for account switching, not onboarding).
 *   - A signature proves ownership of the new wallet address.
 *   - The supplied FCC verification transaction must be to the mailbox contract
 *     and must have been sent by the new wallet address.
 *   - The on-chain request struct is read to obtain TEE-attested flags.
 *   - The walletAddresses index is updated atomically so the old address is released
 *     and the new address is reserved for this UID.
 */
function buildSwitchWalletUpdate(
  currentData: TransactionData | null,
  uid: string,
  oldNormalizedAddress: string,
  newNormalizedAddress: string,
  walletAddress: string,
  isVerifiedHuman: boolean,
  isOldEnoughWallet: boolean,
  verificationTxHash: string,
  now: number,
): TransactionData | undefined {
  // Guard against concurrent switches or profile deletion: the current
  // profile must exist and its wallet address must still be the one we
  // read before starting the switch.
  const currentProfile = currentData?.users?.[uid];
  if (!currentProfile || currentProfile.walletAddress?.toLowerCase() !== oldNormalizedAddress) {
    return undefined;
  }

  const existingLink = currentData?.walletAddresses?.[newNormalizedAddress];
  if (existingLink && existingLink.uid !== uid) {
    return undefined;
  }

  const nextData: TransactionData = JSON.parse(JSON.stringify(currentData ?? {}));
  nextData.users = nextData.users ?? {};
  nextData.walletAddresses = nextData.walletAddresses ?? {};

  // Release the old wallet index entry.
  if (nextData.walletAddresses[oldNormalizedAddress]) {
    delete nextData.walletAddresses[oldNormalizedAddress];
  }

  // Update the user profile with the new wallet and fresh verification record.
  nextData.users[uid] = nextData.users[uid] ?? {};
  nextData.users[uid].walletAddress = walletAddress;
  nextData.users[uid].isVerifiedHuman = isVerifiedHuman;
  nextData.users[uid].isOldEnoughWallet = isOldEnoughWallet;
  nextData.users[uid].verificationTxHash = verificationTxHash;
  nextData.users[uid].verifiedAt = now;
  nextData.users[uid].updatedAt = now;

  // Reserve the new wallet index entry.
  nextData.walletAddresses[newNormalizedAddress] = {
    uid,
    linkedAt: now,
  };

  return nextData;
}

export async function switchLinkedWalletHandler(
  request: CallableRequest<SwitchLinkedWalletData>,
): Promise<SwitchLinkedWalletResult> {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be signed in.");
  }

  const uid = request.auth.uid;
  const walletAddress = request.data.walletAddress;
  const signature = request.data.signature;
  const txHash = request.data.txHash;

  if (!walletAddress || !ethers.isAddress(walletAddress)) {
    throw new HttpsError("invalid-argument", "A valid wallet address is required.");
  }
  if (!signature || typeof signature !== "string" || !signature.startsWith("0x")) {
    throw new HttpsError("invalid-argument", "A valid signature is required.");
  }
  if (!txHash || typeof txHash !== "string" || !/^0x([A-Fa-f0-9]{64})$/.test(txHash)) {
    throw new HttpsError("invalid-argument", "A valid transaction hash is required.");
  }

  const profile = await loadProfile(uid);
  const oldWalletAddress = profile.walletAddress;
  if (!oldWalletAddress || !ethers.isAddress(oldWalletAddress)) {
    throw new HttpsError("failed-precondition", "No wallet address linked to this profile.");
  }
  if (!profile.verifiedAt) {
    throw new HttpsError("failed-precondition", "Profile must be verified before switching wallets.");
  }

  const normalizedAddress = walletAddress.toLowerCase();
  if (oldWalletAddress.toLowerCase() === normalizedAddress) {
    return {
      success: true,
      walletAddress,
      isVerifiedHuman: Boolean(profile.isVerifiedHuman),
      isOldEnoughWallet: Boolean(profile.isOldEnoughWallet),
    };
  }

  const message = `Switch wallet to ${normalizedAddress} for KnockKnock account ${uid}`;

  let recoveredAddress: string;
  try {
    recoveredAddress = ethers.verifyMessage(message, signature);
  } catch (err) {
    console.error("Signature verification failed:", err);
    throw new HttpsError("invalid-argument", "Invalid wallet signature.");
  }
  if (recoveredAddress.toLowerCase() !== normalizedAddress) {
    throw new HttpsError("permission-denied", "Signature does not match the wallet address.");
  }

  // Validate the FCC proof transaction for the new wallet.
  const receipt = await fetchReceipt(txHash);
  const event = parseRequestSent(receipt);

  if (event.sender.toLowerCase() !== normalizedAddress) {
    throw new HttpsError(
      "permission-denied",
      "Transaction sender does not match the new wallet address.",
    );
  }

  const address = getConfiguredMailboxAddress();
  const mailbox = new ethers.Contract(address, MAILBOX_ABI, getProvider());
  let requestStruct: {
    sender: string;
    receiver: string;
    encryptedPreviewMessage: string;
    isVerifiedHuman: boolean;
    isOldEnoughWallet: boolean;
    accepted: boolean;
    isRevealed: boolean;
    expirationTime: bigint;
  };
  try {
    requestStruct = (await mailbox.requests(event.requestId)) as typeof requestStruct;
  } catch (err) {
    console.error("RPC error reading request struct:", err);
    throw new HttpsError("internal", "Unable to read request details from the mailbox.");
  }
  if (requestStruct.sender.toLowerCase() !== normalizedAddress) {
    throw new HttpsError(
      "permission-denied",
      "Request sender does not match the new wallet address.",
    );
  }

  const isVerifiedHuman = Boolean(requestStruct.isVerifiedHuman);
  const isOldEnoughWallet = Boolean(requestStruct.isOldEnoughWallet);
  if (!isVerifiedHuman || !isOldEnoughWallet) {
    throw new HttpsError(
      "failed-precondition",
      "New wallet does not meet the verification thresholds.",
    );
  }

  const now = Date.now();

  try {
    const { committed } = await db.ref().transaction((currentData) =>
      buildSwitchWalletUpdate(
        currentData,
        uid,
        oldWalletAddress.toLowerCase(),
        normalizedAddress,
        walletAddress,
        isVerifiedHuman,
        isOldEnoughWallet,
        txHash,
        now,
      ),
    );
    if (!committed) {
      throw new HttpsError(
        "aborted",
        "Wallet switch conflict — the linked wallet changed during the switch. Please try again.",
      );
    }
  } catch (err: any) {
    if (err instanceof HttpsError) {
      throw err;
    }
    console.error("Failed to switch wallet:", err);
    throw new HttpsError("internal", "Could not switch wallet. Please try again.");
  }

  return {
    success: true,
    walletAddress,
    isVerifiedHuman,
    isOldEnoughWallet,
  };
}

export const switchLinkedWallet = onCall<SwitchLinkedWalletData>(
  {
    region: "us-central1",
    minInstances: 0,
    maxInstances: 10,
    memory: "256MiB",
    timeoutSeconds: 30,
    secrets: [],
  },
  switchLinkedWalletHandler,
);

/* ------------------------------------------------------------------ */
/* Twitter verification via the Flare Data Connector (FDC)             */
/* ------------------------------------------------------------------ */

export interface VerifyTwitterOnboardingData {
  twitterHandle: string;
}

export interface VerifyTwitterOnboardingResult {
  success: boolean;
  isTwitterVerified: boolean;
  twitterHandle: string;
  attestationId: string;
}

interface FdcWeb2JsonRequest {
  attestationType: string;
  sourceId: string;
  requestId: number;
  data: {
    url: string;
    headers: string;
    postParameters: string;
    body: string;
    responseType: string;
    httpMethod: string;
    jmespathExpression: string;
  };
}

interface FdcAttestationStatus {
  status: string;
  response?: { encodedData?: string };
  error?: string;
  message?: string;
}

function normalizeTwitterHandle(handle: string): string {
  const trimmed = handle.trim().replace(/^@+/, "").toLowerCase();
  return TWITTER_HANDLE_REGEX.test(trimmed) ? trimmed : "";
}

/**
 * Build the FDC Web2Json attestation request for a Twitter v2 user lookup.
 * The JMESPath expression `data.verified` selects the `verified` boolean from
 * the Twitter `GET /2/users/by/username/:username` response.
 */
function buildTwitterFdcRequest(handle: string): FdcWeb2JsonRequest {
  const base = twitterApiBaseUrl.value().replace(/\/$/, "");
  const url = `${base}/users/by/username/${encodeURIComponent(
    handle,
  )}?user.fields=public_metrics,verified`;

  return {
    attestationType: "Web2Json",
    sourceId: "twitter",
    requestId: 0,
    data: {
      url,
      headers: JSON.stringify({
        Authorization: `Bearer ${twitterBearerToken.value()}`,
      }),
      postParameters: "",
      body: "",
      responseType: "string",
      httpMethod: "GET",
      jmespathExpression: "data.verified",
    },
  };
}

async function submitFdcAttestation(
  request: FdcWeb2JsonRequest,
): Promise<string> {
  const endpoint = `${fdcVerifierUrl.value().replace(/\/$/, "")}/verifier/api/0.1/Attestation/post`;
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
    console.log(`[verifyTwitterOnboarding] submitted attestation: ${attestationId}`);
    return attestationId;
  } finally {
    clearTimeout(timeout);
  }
}

async function pollFdcAttestation(attestationId: string): Promise<string> {
  const endpoint = `${fdcVerifierUrl.value().replace(/\/$/, "")}/verifier/api/0.1/Attestation/status/${encodeURIComponent(
    attestationId,
  )}`;
  const maxAttempts = Number(fdcPollMaxAttempts.value());
  const intervalMs = Number(fdcPollIntervalMs.value());

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
        throw new Error(
          `FDC attestation rejected: ${body.error ?? body.message ?? "unknown"}`,
        );
      }
      if (body.status === "DONE") {
        const encodedData = body.response?.encodedData;
        if (!encodedData) {
          throw new Error("FDC attestation completed without encoded data");
        }
        console.log(
          `[verifyTwitterOnboarding] attestation finalized on attempt ${attempt + 1}`,
        );
        return encodedData;
      }
    } finally {
      clearTimeout(timeout);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error("timed out waiting for the FDC twitter attestation");
}

/** Decode the FDC Web2Json response into a `verified` boolean. */
function decodeTwitterVerifiedFromFdc(encodedData: string): boolean {
  try {
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
      ["bytes"],
      encodedData,
    ) as unknown as [string];
    const tail = ethers.hexlify(decoded[0]).slice(2);
    const ascii = Buffer.from(tail, "hex").toString("utf-8").trim();
    const lastToken = ascii.split(/ |"/).filter(Boolean).pop() ?? "";
    return lastToken.toLowerCase() === "true" || lastToken === "1";
  } catch (err) {
    console.error(`[verifyTwitterOnboarding] failed to decode verified flag:`, err);
    throw new Error(`FDC twitter response was not decodable: ${err}`);
  }
}

/**
 * Server-side Twitter verification via the Flare Data Connector.
 * @returns `[isTwitterVerified, attestationId]`.
 */
async function checkTwitterVerificationServer(
  walletAddress: string,
  handle: string,
): Promise<[boolean, string]> {
  const useMock =
    fdcMockTwitter.value().toLowerCase() === "true" ||
    !fdcVerifierUrl.value().trim() ||
    !twitterBearerToken.value().trim();

  if (useMock) {
    // Deterministic mock running entirely server-side: the client cannot
    // influence the result. Returns false for obvious spam handles.
    const spamPrefixes = ["bot", "spam", "fake", "scam"];
    const isSpam = spamPrefixes.some((p) => handle.startsWith(p));
    const isTwitterVerified = !isSpam && handle.length >= 2;
    const attestationId = ethers.id(
      `mock-twitter-${walletAddress.toLowerCase()}-${handle}`,
    );
    console.log(
      `[verifyTwitterOnboarding] mock verified=${isTwitterVerified} handle=${handle}`,
    );
    return [isTwitterVerified, attestationId];
  }

  const fdcRequest = buildTwitterFdcRequest(handle);
  const attestationId = await submitFdcAttestation(fdcRequest);
  const encodedData = await pollFdcAttestation(attestationId);
  const isTwitterVerified = decodeTwitterVerifiedFromFdc(encodedData);
  return [isTwitterVerified, attestationId];
}

/**
 * Verifies a Twitter handle via the Flare Data Connector and, only if the FDC
 * attestation confirms it is a verified account, writes the `twitterVerified`
 * flag to the user's profile and the public-by-wallet badge index.
 *
 * Security invariants enforced:
 *   - Caller must be authenticated.
 *   - The profile must have a linked wallet address (the badge is keyed by it).
 *   - The FDC attestation is performed server-side; the client cannot forge it.
 *   - Only a verified attestation writes the flag (RTDB rules are write-false).
 */
export async function verifyTwitterOnboardingHandler(
  request: CallableRequest<VerifyTwitterOnboardingData>,
): Promise<VerifyTwitterOnboardingResult> {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be signed in.");
  }

  const uid = request.auth.uid;
  const rawHandle = request.data?.twitterHandle;
  if (typeof rawHandle !== "string" || !rawHandle.trim()) {
    throw new HttpsError("invalid-argument", "A Twitter handle is required.");
  }
  const handle = normalizeTwitterHandle(rawHandle);
  if (!handle) {
    throw new HttpsError(
      "invalid-argument",
      "Twitter handle must be 1-15 letters, numbers, or underscores.",
    );
  }

  const profile = await loadProfile(uid);
  const walletAddress = profile.walletAddress;
  if (!walletAddress || !ethers.isAddress(walletAddress)) {
    throw new HttpsError(
      "failed-precondition",
      "No wallet address linked to this profile. Connect your wallet first.",
    );
  }

  let isTwitterVerified: boolean;
  let attestationId: string;
  try {
    [isTwitterVerified, attestationId] = await checkTwitterVerificationServer(
      walletAddress,
      handle,
    );
  } catch (err: any) {
    console.error("[verifyTwitterOnboarding] FDC verification failed:", err);
    throw new HttpsError(
      "internal",
      err?.message ?? "Twitter verification failed.",
    );
  }

  if (!isTwitterVerified) {
    return {
      success: false,
      isTwitterVerified: false,
      twitterHandle: handle,
      attestationId,
    };
  }

  const normalizedAddress = walletAddress.toLowerCase();
  const now = Date.now();
  const badgeRecord = {
    twitterVerified: true,
    twitterHandle: handle,
    walletAddress: normalizedAddress,
    verifiedBy: uid,
    attestationId,
    verifiedAt: now,
  };

  // Admin SDK bypasses RTDB rules, so it can write the write-false nodes.
  await Promise.all([
    db.ref(`twitterByWallet/${normalizedAddress}`).set(badgeRecord),
    db.ref(`users/${uid}`).update({
      twitterVerified: true,
      twitterHandle: handle,
      twitterVerifiedAt: now,
      updatedAt: now,
    }),
  ]);

  return {
    success: true,
    isTwitterVerified: true,
    twitterHandle: handle,
    attestationId,
  };
}

export const verifyTwitterOnboarding = onCall<VerifyTwitterOnboardingData>(
  {
    region: "us-central1",
    minInstances: 0,
    maxInstances: 10,
    memory: "256MiB",
    // FDC polling can take longer than the default 30s under load.
    timeoutSeconds: 180,
    secrets: [],
  },
  verifyTwitterOnboardingHandler,
);
