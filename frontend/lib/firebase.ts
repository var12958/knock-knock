/**
 * Firebase Realtime Database configuration for KnockKnock chat.
 *
 * Create a Firebase project at https://console.firebase.google.com/, enable the
 * Realtime Database, and copy your web app config into .env.local.
 */

import { initializeApp, getApps, getApp } from "firebase/app";
import { getDatabase, connectDatabaseEmulator } from "firebase/database";

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

export function parseEmulatorUrl(url: string): { host: string; port: number } | null {
  try {
    const parsed = new URL(url.startsWith("http") ? url : `http://${url}`);
    const port = Number(parsed.port);
    return { host: parsed.hostname, port: Number.isNaN(port) ? 5001 : port };
  } catch {
    return null;
  }
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
  return getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
}

export const firebaseApp = getFirebaseApp();
export const realtimeDb = firebaseApp ? getDatabase(firebaseApp) : null;

if (
  firebaseApp &&
  realtimeDb &&
  process.env.NODE_ENV === "development" &&
  process.env.NEXT_PUBLIC_FIREBASE_DATABASE_EMULATOR
) {
  const parsed = parseEmulatorUrl(process.env.NEXT_PUBLIC_FIREBASE_DATABASE_EMULATOR);
  if (parsed) {
    const { host, port } = parsed;
    if (typeof console !== "undefined") {
      console.log(`[Firebase] Connecting Database emulator at ${host}:${port}`);
    }
    connectDatabaseEmulator(realtimeDb, host, port);
  } else if (typeof console !== "undefined") {
    console.warn(
      "NEXT_PUBLIC_FIREBASE_DATABASE_EMULATOR is set but could not be parsed:",
      process.env.NEXT_PUBLIC_FIREBASE_DATABASE_EMULATOR,
    );
  }
}
