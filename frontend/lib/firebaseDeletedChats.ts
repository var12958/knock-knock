"use client";

import { ref, set, onValue, type Unsubscribe } from "firebase/database";
import { realtimeDb } from "./firebase";

/**
 * Per-user "hidden" chat list for the KnockKnock sidebar.
 *
 * Each accepted chat a user hides is recorded as a truthy flag here. We use a
 * dedicated top-level node — exactly like `lib/firebaseContacts.ts` — because
 * the `users/$uid` node in `firebase/database.rules.json` is `.write: false`
 * with a strict `.validate`, so writing under `users/{uid}/deletedChats/...`
 * would be rejected. The top-level `deletedChats/{uid}/{requestId}` node gets
 * its own owner-scoped read/write rule (see database.rules.json).
 *
 * Shape: `deletedChats/{uid}/{requestId} = true`
 *
 * Hiding a chat does NOT touch the on-chain request — it is purely a UI
 * preference. Re-fetching accepted chats from the contract filters out any
 * request id present in this node.
 */

/** Subscribe to the user's hidden-chat id set in real time. Returns an unsubscribe fn. */
export function subscribeDeletedChats(
  uid: string,
  onChange: (deletedIds: Set<string>) => void,
): Unsubscribe {
  if (!realtimeDb) {
    throw new Error("Firebase Database is not configured.");
  }
  const nodeRef = ref(realtimeDb, `deletedChats/${uid}`);
  return onValue(
    nodeRef,
    (snapshot) => {
      const value = snapshot.val() as Record<string, boolean> | null;
      const result = new Set<string>();
      if (value && typeof value === "object") {
        for (const [requestId, flag] of Object.entries(value)) {
          if (flag) result.add(String(requestId));
        }
      }
      onChange(result);
    },
    (err) => {
      // Surface subscription errors so they are not silently swallowed.
      console.error("[firebaseDeletedChats] subscription error:", err);
    },
  );
}

/** Hide a chat from the user's sidebar (write a truthy flag). */
export async function addDeletedChat(
  uid: string,
  requestId: string,
): Promise<void> {
  if (!realtimeDb) {
    throw new Error("Firebase Database is not configured.");
  }
  await set(ref(realtimeDb, `deletedChats/${uid}/${requestId}`), true);
}

/** Un-hide a chat (clears the flag) — available for an undo affordance. */
export async function removeDeletedChat(
  uid: string,
  requestId: string,
): Promise<void> {
  if (!realtimeDb) {
    throw new Error("Firebase Database is not configured.");
  }
  // `set` with null removes the node, keeping the hidden list clean.
  await set(ref(realtimeDb, `deletedChats/${uid}/${requestId}`), null);
}