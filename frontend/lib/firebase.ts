/**
 * Firebase configuration for KnockKnock.
 *
 * Uses the real Firebase Realtime Database in development and production.
 * The local Realtime Database emulator is intentionally disabled.
 */

import { initializeApp, getApps, getApp } from "firebase/app";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

function isConfigComplete(): boolean {
  return !!(
    firebaseConfig.apiKey &&
    firebaseConfig.authDomain &&
    firebaseConfig.databaseURL &&
    firebaseConfig.projectId &&
    firebaseConfig.storageBucket &&
    firebaseConfig.messagingSenderId &&
    firebaseConfig.appId
  );
}

function getFirebaseApp() {
  if (!isConfigComplete()) {
    if (typeof console !== "undefined") {
      console.warn(
        "Firebase configuration is incomplete. Auth and database features will be unavailable.",
      );
    }

    return null;
  }

  return getApps().length === 0
    ? initializeApp(firebaseConfig)
    : getApp();
}

export const firebaseApp = getFirebaseApp();

export const realtimeDb = firebaseApp
  ? getDatabase(firebaseApp)
  : null;