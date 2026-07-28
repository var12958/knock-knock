"use client";

import { ref, get, set, onValue, type Unsubscribe } from "firebase/database";
import { realtimeDb } from "./firebase";

/**
 * Private contact nicknames for the KnockKnock inbox.
 *
 * Each user keeps their own address book so the labels are private to them:
 *   contacts/{uid}/{senderAddress} = "nickname"
 *
 * This is a dedicated top-level node (see firebase/database.rules.json) so the
 * strict `.validate` rule on `users/$uid` does not reject nickname writes. The
 * address key is lowercased so checksummed and lowercase addresses resolve to
 * the same contact entry. Setting a value of `null` clears the nickname.
 */

function contactsRef(uid: string, senderAddress: string) {
  if (!realtimeDb) {
    throw new Error("Firebase Database is not configured.");
  }
  return ref(realtimeDb, `contacts/${uid}/${senderAddress.toLowerCase()}`);
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

/**
 * Subscribe to the user's entire private address book in real time.
 *
 * The per-contact write path is `contacts/${uid}/${senderAddress}` (see
 * `contactsRef`). This subscribes to the parent `contacts/${uid}` node and
 * delivers a map keyed by lowercase sender address whenever the DB changes —
 * including on the very first load. Using `onValue` (instead of a one-shot
 * `get()` keyed off the chat list) means nicknames populate as soon as the
 * user is authenticated, independent of when the on-chain chats finish
 * loading, and stay in sync across reloads/tabs/edits.
 *
 * Returns an unsubscribe function.
 */
export function subscribeNicknames(
  uid: string,
  onChange: (nicknames: Record<string, string>) => void,
): Unsubscribe {
  if (!realtimeDb) {
    throw new Error("Firebase Database is not configured.");
  }
  const nodeRef = ref(realtimeDb, `contacts/${uid}`);
  return onValue(
    nodeRef,
    (snapshot) => {
      const value = snapshot.val() as Record<string, string> | null;
      const result: Record<string, string> = {};
      if (value && typeof value === "object") {
        for (const [address, nickname] of Object.entries(value)) {
          if (typeof nickname === "string" && nickname.trim()) {
            result[address.toLowerCase()] = nickname.trim();
          }
        }
      }
      onChange(result);
    },
    (err) => {
      // Surface subscription errors so they are not silently swallowed.
      console.error("[firebaseContacts] nickname subscription error:", err);
    },
  );
}