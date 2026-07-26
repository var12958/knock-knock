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
