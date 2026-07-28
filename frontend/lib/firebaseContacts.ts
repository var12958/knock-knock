"use client";

import { ref, get, set } from "firebase/database";
import { realtimeDb } from "./firebase";

/**
 * Private contact nicknames for the KnockKnock inbox.
 *
 * Each user keeps their own address book so the labels are private to them:
 *   users/{uid}/contacts/{senderAddress} = "nickname"
 *
 * The address key is lowercased so checksummed and lowercase addresses resolve
 * to the same contact entry. Setting a value of `null` clears the nickname.
 */

function contactsRef(uid: string, senderAddress: string) {
  if (!realtimeDb) {
    throw new Error("Firebase Database is not configured.");
  }
  return ref(realtimeDb, `users/${uid}/contacts/${senderAddress.toLowerCase()}`);
}

/** Fetch a single contact nickname. Returns null if none is set. */
export async function getNickname(
  uid: string,
  senderAddress: string,
): Promise<string | null> {
  if (!realtimeDb) {
    throw new Error("Firebase Database is not configured.");
  }
  const snapshot = await get(contactsRef(uid, senderAddress));
  if (!snapshot.exists()) return null;
  const value = snapshot.val();
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Fetch nicknames for many contacts in parallel. Missing entries are omitted. */
export async function getNicknames(
  uid: string,
  senderAddresses: string[],
): Promise<Record<string, string>> {
  if (!realtimeDb) {
    throw new Error("Firebase Database is not configured.");
  }
  const entries = await Promise.all(
    senderAddresses.map(async (address) => {
      const nickname = await getNickname(uid, address);
      return [address.toLowerCase(), nickname] as const;
    }),
  );
  const result: Record<string, string> = {};
  for (const [address, nickname] of entries) {
    if (nickname) result[address] = nickname;
  }
  return result;
}

/** Save a contact nickname. An empty string clears the entry. */
export async function setNickname(
  uid: string,
  senderAddress: string,
  nickname: string,
): Promise<void> {
  if (!realtimeDb) {
    throw new Error("Firebase Database is not configured.");
  }
  const trimmed = nickname.trim();
  // `set` with null removes the node, keeping the address book clean.
  await set(contactsRef(uid, senderAddress), trimmed || null);
}