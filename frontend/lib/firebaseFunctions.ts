"use client";

import { getFunctions, httpsCallable } from "firebase/functions";
import { firebaseApp } from "./firebase";
import { auth } from "@/context/FirebaseAuthContext";

/*
 * Firebase Functions is used ONLY for Twitter verification.
 *
 * The other five backend operations are handled by the Render backend.
 */

const functions = firebaseApp ? getFunctions(firebaseApp) : null;

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL?.replace(/\/+$/, "");

async function callRender<TInput, TResult>(
  endpoint: string,
  input: TInput,
): Promise<TResult> {
  if (!BACKEND_URL) {
    throw new Error("Render backend URL is not configured.");
  }

  const currentUser = auth?.currentUser;

  if (!currentUser) {
    throw new Error("You must be signed in.");
  }

  const token = await currentUser.getIdToken();

  const response = await fetch(
    `${BACKEND_URL}/api/${endpoint}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(input),
    },
  );

  let data: unknown = null;

  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const errorData = data as
      | {
          message?: string;
          error?: string;
        }
      | null;

    throw new Error(
      errorData?.message ||
        errorData?.error ||
        `Backend request failed (${response.status})`,
    );
  }

  return data as TResult;
}

/* ================================================================ */
/* Reserve Username                                                 */
/* ================================================================ */

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
  const currentUser = auth?.currentUser;

  if (!currentUser) {
    throw new Error("You must be signed in.");
  }

  /*
   * Firebase Authentication is the source of truth for email/display name.
   *
   * This prevents the Render backend from receiving an undefined email
   * when the onboarding form only supplies a username.
   */
  const request: ReserveUsernameInput = {
    username: input.username.trim(),
    email: input.email ?? currentUser.email ?? undefined,
    displayName:
      input.displayName ??
      currentUser.displayName ??
      undefined,
  };

  return callRender<
    ReserveUsernameInput,
    ReserveUsernameResult
  >(
    "reserveUsernameAndCreateProfile",
    request,
  );
}

/* ================================================================ */
/* Link Wallet                                                      */
/* ================================================================ */

export interface LinkWalletInput {
  walletAddress: string;
  signature: string;
}

export interface LinkWalletResult {
  success: boolean;
  walletAddress: string;
}

export async function linkWallet(
  input: LinkWalletInput,
): Promise<LinkWalletResult> {
  return callRender<
    LinkWalletInput,
    LinkWalletResult
  >(
    "linkWallet",
    input,
  );
}

/* ================================================================ */
/* Publish Chat Request                                             */
/* ================================================================ */

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
  return callRender<
    PublishChatRequestInput,
    PublishChatRequestResult
  >(
    "publishChatRequest",
    input,
  );
}

/* ================================================================ */
/* FCC Onboarding Verification                                      */
/* ================================================================ */

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
  return callRender<
    VerifyOnboardingInput,
    VerifyOnboardingResult
  >(
    "verifyFCCOnboarding",
    input,
  );
}

/* ================================================================ */
/* Switch Linked Wallet                                             */
/* ================================================================ */

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

export async function switchLinkedWallet(
  input: SwitchLinkedWalletInput,
): Promise<SwitchLinkedWalletResult> {
  return callRender<
    SwitchLinkedWalletInput,
    SwitchLinkedWalletResult
  >(
    "switchLinkedWallet",
    input,
  );
}

/* ================================================================ */
/* Twitter Verification — Firebase Callable Function ONLY          */
/* ================================================================ */

export interface VerifyTwitterOnboardingInput {
  twitterHandle: string;
}

export interface VerifyTwitterOnboardingResult {
  success: boolean;
  isTwitterVerified: boolean;
  twitterHandle: string;
  attestationId: string;
}

export async function verifyTwitterOnboarding(
  input: VerifyTwitterOnboardingInput,
): Promise<VerifyTwitterOnboardingResult> {
  if (!functions) {
    throw new Error(
      "Firebase Functions is not configured.",
    );
  }

  const callable = httpsCallable<
    VerifyTwitterOnboardingInput,
    VerifyTwitterOnboardingResult
  >(
    functions,
    "verifyTwitterOnboarding",
  );

  const response = await callable(input);

  return response.data;
}