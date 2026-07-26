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

if (
  db &&
  process.env.NODE_ENV === "development" &&
  process.env.NEXT_PUBLIC_FIREBASE_DATABASE_EMULATOR
) {
  const parsed = parseEmulatorUrl(process.env.NEXT_PUBLIC_FIREBASE_DATABASE_EMULATOR);
  if (parsed) {
    const { host, port } = parsed;
    if (typeof console !== "undefined") {
      console.log(`[Firebase] Connecting Database emulator at ${host}:${port}`);
    }
    connectDatabaseEmulator(db, host, port);
  } else if (typeof console !== "undefined") {
    console.warn(
      "NEXT_PUBLIC_FIREBASE_DATABASE_EMULATOR is set but could not be parsed:",
      process.env.NEXT_PUBLIC_FIREBASE_DATABASE_EMULATOR,
    );
  }
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
  const snapshot = await get(child(ref(db), `users/${uid}`));
  if (!snapshot.exists()) {
    return null;
  }
  return snapshot.val() as UserProfile;
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
