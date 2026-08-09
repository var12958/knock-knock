"use client";

import {
  getDatabase,
  ref,
  get,
  child,
  connectDatabaseEmulator,
} from "firebase/database";
import { firebaseApp, parseEmulatorUrl } from "./firebase";

const db = firebaseApp ? getDatabase(firebaseApp) : null;

if (db && process.env.NODE_ENV === "development") {
  if (typeof console !== "undefined") {
    console.log("[Firebase] Connecting Database emulator at 127.0.0.1:9000");
  }
  connectDatabaseEmulator(db, "127.0.0.1", 9000);
}

export interface UserProfile {
  uid: string;
  username: string;
  email?: string | null;
  displayName?: string | null;
  walletAddress?: string | null;
  isVerifiedHuman?: boolean;
  isOldEnoughWallet?: boolean;
  verificationTxHash?: string | null;
  verifiedAt?: number | null;
  /** Set to true after a successful FDC Twitter attestation. */
  twitterVerified?: boolean;
  twitterHandle?: string | null;
  twitterVerifiedAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * Fetch a user's profile.
 */
export async function getUserProfile(uid: string): Promise<UserProfile | null> {
  if (!db) {
    throw new Error("Firebase Database is not configured.");
  }
  console.log(`[getUserProfile] fetching profile for uid=${uid}`);
  const snapshot = await get(child(ref(db), `users/${uid}`));
  if (!snapshot.exists()) {
    console.log(`[getUserProfile] no profile found for uid=${uid}`);
    return null;
  }
  const profile = snapshot.val() as UserProfile;
  console.log(`[getUserProfile] profile found:`, profile);
  return profile;
}

/**
 * Check whether a username is already taken.
 * This is a UX convenience; the actual reservation is enforced server-side.
 */
export async function isUsernameAvailable(username: string): Promise<boolean> {
  if (!db) {
    throw new Error("Firebase Database is not configured.");
  }
  const snapshot = await get(
    child(ref(db), `usernames/${encodeUsername(username)}`),
  );
  return !snapshot.exists();
}

export function encodeUsername(username: string): string {
  return username
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/* ------------------------------------------------------------------ */
/* Twitter verification (FDC) — read-only client lookups               */
/* ------------------------------------------------------------------ */
/* The `twitterByWallet` node is write-false; only the verifyTwitterOnboarding
 * Cloud Function (using the Admin SDK) can write it after a server-side FDC
 * attestation. The helpers below are read-only and used by the inbox to badge
 * senders by wallet address. */

/**
 * Look up whether a given wallet address has a verified Twitter handle.
 * Used by the inbox to render the Twitter Verified badge next to senders.
 */
export async function getTwitterVerified(
  walletAddress: string,
): Promise<boolean> {
  if (!db) {
    throw new Error("Firebase Database is not configured.");
  }
  if (!walletAddress) return false;
  const snapshot = await get(
    child(ref(db), `twitterByWallet/${walletAddress.toLowerCase()}`),
  );
  if (!snapshot.exists()) return false;
  const val = snapshot.val() as {
    twitterVerified?: boolean;
  } | null;
  return val?.twitterVerified === true;
}

/**
 * Batch-fetch the Twitter-verified status for many wallet addresses at once.
 * @returns A lowercase-address → boolean map.
 */
export async function getTwitterVerifiedBatch(
  walletAddresses: string[],
): Promise<Record<string, boolean>> {
  if (!db) {
    throw new Error("Firebase Database is not configured.");
  }
  const unique = Array.from(
    new Set(walletAddresses.map((a) => a.toLowerCase())),
  );
  const result: Record<string, boolean> = {};
  await Promise.all(
    unique.map(async (addr) => {
      try {
        result[addr] = await getTwitterVerified(addr);
      } catch (err) {
        console.error(`[getTwitterVerifiedBatch] failed for ${addr}:`, err);
        result[addr] = false;
      }
    }),
  );
  return result;
}
