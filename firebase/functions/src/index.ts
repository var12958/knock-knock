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

  // Resolve the receiver's UID from the wallet-address index.
  const receiverAddress = event.receiver.toLowerCase();
  const receiverSnapshot = await db.ref(`walletAddresses/${receiverAddress}`).get();
  if (!receiverSnapshot.exists()) {
    throw new HttpsError(
      "not-found",
      "Receiver wallet is not linked to a KnockKnock profile.",
    );
  }

  const receiverUid = (receiverSnapshot.val() as { uid?: string }).uid;
  if (!receiverUid) {
    throw new HttpsError("not-found", "Receiver profile not found.");
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
    if (existingData.senderUid !== uid || existingData.receiverUid !== receiverUid) {
      throw new HttpsError("already-exists", "Chat request already exists with different participants.");
    }
    return { success: true, requestId, receiverUid };
  }

  await requestRef.set({
    senderUid: uid,
    receiverUid,
    senderAddress: event.sender,
    receiverAddress: event.receiver,
    createdAt: now,
  });

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
