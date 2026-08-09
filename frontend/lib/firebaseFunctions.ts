"use client";

import {
  getFunctions,
  httpsCallable,
  connectFunctionsEmulator,
} from "firebase/functions";
import { firebaseApp } from "./firebase";

const functions = firebaseApp ? getFunctions(firebaseApp) : null;

if (functions && process.env.NODE_ENV === "development") {
  if (typeof console !== "undefined") {
    console.log("[Firebase] Connecting Functions emulator at 127.0.0.1:5001");
  }
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
}

export interface ReserveUsernameInput {
  username: string;
  email?: string;
  displayName?: string;
}

export interface ReserveUsernameResult {
  success: boolean;
  username: string;
}

export async function reserveUsernameAndCreateProfile(
  input: ReserveUsernameInput,
): Promise<ReserveUsernameResult> {
  if (!functions) {
    throw new Error("Firebase Functions is not configured.");
  }
  const callable = httpsCallable<ReserveUsernameInput, ReserveUsernameResult>(
    functions,
    "reserveUsernameAndCreateProfile",
  );
  const response = await callable(input);
  return response.data;
}

export interface LinkWalletInput {
  walletAddress: string;
  signature: string;
}

export interface LinkWalletResult {
  success: boolean;
  walletAddress: string;
}

export async function linkWallet(input: LinkWalletInput): Promise<LinkWalletResult> {
  if (!functions) {
    throw new Error("Firebase Functions is not configured.");
  }
  const callable = httpsCallable<LinkWalletInput, LinkWalletResult>(
    functions,
    "linkWallet",
  );
  const response = await callable(input);
  return response.data;
}

export interface PublishChatRequestInput {
  txHash: string;
}

export interface PublishChatRequestResult {
  success: boolean;
  requestId: string;
  receiverUid?: string;
}

export async function publishChatRequest(
  input: PublishChatRequestInput,
): Promise<PublishChatRequestResult> {
  if (!functions) {
    throw new Error("Firebase Functions is not configured.");
  }
  const callable = httpsCallable<PublishChatRequestInput, PublishChatRequestResult>(
    functions,
    "publishChatRequest",
  );
  const response = await callable(input);
  return response.data;
}

export interface VerifyOnboardingInput {
  txHash: string;
}

export interface VerifyOnboardingResult {
  success: boolean;
  isVerifiedHuman: boolean;
  isOldEnoughWallet: boolean;
}

export async function verifyOnboarding(
  input: VerifyOnboardingInput,
): Promise<VerifyOnboardingResult> {
  if (!functions) {
    throw new Error("Firebase Functions is not configured.");
  }
  const callable = httpsCallable<VerifyOnboardingInput, VerifyOnboardingResult>(
    functions,
    "verifyFCCOnboarding",
  );
  const response = await callable(input);
  return response.data;
}

export interface SwitchLinkedWalletInput {
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
 * Switch the wallet linked to an already-verified Firebase profile after the
 * client has run the FCC verification flow for the new address. The server
 * validates ownership via signature and re-verifies the FCC transaction on-chain.
 */
export async function switchLinkedWallet(
  input: SwitchLinkedWalletInput,
): Promise<SwitchLinkedWalletResult> {
  if (!functions) {
    throw new Error("Firebase Functions is not configured.");
  }
  const callable = httpsCallable<
    SwitchLinkedWalletInput,
    SwitchLinkedWalletResult
  >(functions, "switchLinkedWallet");
  const response = await callable(input);
  return response.data;
}

export interface VerifyTwitterOnboardingInput {
  twitterHandle: string;
}

export interface VerifyTwitterOnboardingResult {
  success: boolean;
  isTwitterVerified: boolean;
  twitterHandle: string;
  attestationId: string;
}

/**
 * Verify a Twitter handle via the Flare Data Connector through a secure Cloud
 * Function. The function performs the FDC attestation server-side and only
 * persists the badge if the attestation confirms a verified account — the
 * client cannot forge the flag (the `twitterByWallet` node is write-false).
 */
export async function verifyTwitterOnboarding(
  input: VerifyTwitterOnboardingInput,
): Promise<VerifyTwitterOnboardingResult> {
  if (!functions) {
    throw new Error("Firebase Functions is not configured.");
  }
  const callable = httpsCallable<
    VerifyTwitterOnboardingInput,
    VerifyTwitterOnboardingResult
  >(functions, "verifyTwitterOnboarding");
  const response = await callable(input);
  return response.data;
}
