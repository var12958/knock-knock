"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from "react";
import {
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  signOut,
  updateProfile,
  type User,
  type UserCredential,
} from "firebase/auth";
import { firebaseApp } from "@/lib/firebase";

const SESSION_COOKIE_NAME = "kk_uid";
const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days
const AUTH_STATE_TIMEOUT_MS = 5000;

function setSessionCookie(uid: string): void {
  if (typeof document === "undefined") return;
  const secure = location.protocol === "https:" ? ";Secure" : "";
  document.cookie = `${SESSION_COOKIE_NAME}=${uid};path=/;max-age=${SESSION_COOKIE_MAX_AGE};SameSite=Lax${secure}`;
}

function clearSessionCookie(): void {
  if (typeof document === "undefined") return;
  const secure = location.protocol === "https:" ? ";Secure" : "";
  document.cookie = `${SESSION_COOKIE_NAME}=;path=/;max-age=0;SameSite=Lax${secure}`;
}

interface FirebaseAuthState {
  user: User | null;
  loading: boolean;
  error: string | null;
  signInWithGoogle: () => Promise<UserCredential | null>;
  signInWithEmail: (email: string, password: string) => Promise<UserCredential | null>;
  signUpWithEmail: (email: string, password: string, displayName: string) => Promise<UserCredential | null>;
  logout: () => Promise<void>;
  clearError: () => void;
}

const FirebaseAuthContext = createContext<FirebaseAuthState | undefined>(
  undefined,
);

const auth = firebaseApp ? getAuth(firebaseApp) : null;

export function FirebaseAuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!auth) {
      setLoading(false);
      setError("Firebase is not configured. Sign-in is unavailable.");
      return;
    }

    let resolved = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const unsubscribe = onAuthStateChanged(
      auth,
      (firebaseUser) => {
        resolved = true;
        if (timeoutId) clearTimeout(timeoutId);
        setError(null);
        setUser(firebaseUser);
        setLoading(false);
        if (firebaseUser) {
          setSessionCookie(firebaseUser.uid);
        } else {
          clearSessionCookie();
        }
      },
      (err) => {
        resolved = true;
        if (timeoutId) clearTimeout(timeoutId);
        console.error("Firebase auth state error:", err);
        setError("Authentication service unavailable. Please try signing in again.");
        setLoading(false);
      },
    );

    // If the auth listener hangs (e.g. the emulator is not running), stop
    // waiting so the UI can still render a login form.
    timeoutId = setTimeout(() => {
      if (!resolved) {
        console.warn("Firebase auth state listener timed out.");
        setLoading(false);
        setError(
          "Authentication is taking too long. You can try signing in below.",
        );
      }
    }, AUTH_STATE_TIMEOUT_MS);

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
      unsubscribe();
    };
  }, []);

  async function signInWithGoogle(): Promise<UserCredential | null> {
    setError(null);
    if (!auth) {
      setError("Firebase is not configured. Sign-in is unavailable.");
      return null;
    }
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      const credential = await signInWithPopup(auth, provider);
      return credential;
    } catch (err: any) {
      console.error("Google sign-in failed:", err);
      setError(err.message ?? "Google sign-in failed");
      return null;
    }
  }

  async function signInWithEmail(
    email: string,
    password: string,
  ): Promise<UserCredential | null> {
    setError(null);
    if (!auth) {
      setError("Firebase is not configured. Sign-in is unavailable.");
      return null;
    }
    try {
      const credential = await signInWithEmailAndPassword(auth, email, password);
      return credential;
    } catch (err: any) {
      console.error("Email sign-in failed:", err);
      setError(err.message ?? "Email sign-in failed");
      return null;
    }
  }

  async function signUpWithEmail(
    email: string,
    password: string,
    displayName: string,
  ): Promise<UserCredential | null> {
    setError(null);
    if (!auth) {
      setError("Firebase is not configured. Sign-in is unavailable.");
      return null;
    }
    try {
      const credential = await createUserWithEmailAndPassword(
        auth,
        email,
        password,
      );
      await updateProfile(credential.user, { displayName });
      return credential;
    } catch (err: any) {
      console.error("Email sign-up failed:", err);
      setError(err.message ?? "Email sign-up failed");
      return null;
    }
  }

  async function logout(): Promise<void> {
    setError(null);
    if (!auth) {
      clearSessionCookie();
      return;
    }
    try {
      await signOut(auth);
      clearSessionCookie();
    } catch (err: any) {
      console.error("Sign-out failed:", err);
      setError(err.message ?? "Sign-out failed");
    }
  }

  function clearError() {
    setError(null);
  }

  return (
    <FirebaseAuthContext.Provider
      value={{
        user,
        loading,
        error,
        signInWithGoogle,
        signInWithEmail,
        signUpWithEmail,
        logout,
        clearError,
      }}
    >
      {children}
    </FirebaseAuthContext.Provider>
  );
}

export function useFirebaseAuth(): FirebaseAuthState {
  const context = useContext(FirebaseAuthContext);
  if (context === undefined) {
    throw new Error(
      "useFirebaseAuth must be used within a FirebaseAuthProvider",
    );
  }
  return context;
}

export { auth };

export async function getFirebaseIdToken(): Promise<string> {
  if (!auth?.currentUser) {
    throw new Error("You must be signed in.");
  }

  return await auth.currentUser.getIdToken();
}
