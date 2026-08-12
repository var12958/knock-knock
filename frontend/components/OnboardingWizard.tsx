"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useFirebaseAuth } from "@/context/FirebaseAuthContext";
import { useWeb3 } from "@/context/Web3Context";
import { isUsernameAvailable, getUserProfile, encodeUsername } from "@/lib/firebaseProfile";
import {
  reserveUsernameAndCreateProfile,
  linkWallet,
  verifyOnboarding,
} from "@/lib/firebaseFunctions";
import { runFCCVerification } from "@/lib/runFCCVerification";
import { COSTON2_CHAIN_ID } from "@/lib/chain";
import { AnimatePresence } from "framer-motion";
import VerificationLoader from "@/components/VerificationLoader";

const USERNAME_MIN_LENGTH = 3;
const USERNAME_MAX_LENGTH = 24;
const PROFILE_LOOKUP_TIMEOUT_MS = 15_000;

export type OnboardingStep =
  | "auth"
  | "username"
  | "wallet"
  | "verify"
  | "complete";

interface VerificationResult {
  isVerifiedHuman: boolean;
  isOldEnoughWallet: boolean;
  txHash: string;
}

export default function OnboardingWizard() {
  const router = useRouter();
  const {
    user,
    loading: authLoading,
    error: authError,
    signInWithGoogle,
    signInWithEmail,
    signUpWithEmail,
  } = useFirebaseAuth();
  const { address, chainId, signer, connect } = useWeb3();

  const [step, setStep] = useState<OnboardingStep>("auth");
  const [error, setError] = useState<string | null>(null);

  // Auth step state
  const [authMode, setAuthMode] = useState<"google" | "email" | "signup">("google");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [authName, setAuthName] = useState("");

  // Username step state
  const [username, setUsername] = useState("");
  const [checkingUsername, setCheckingUsername] = useState(false);

  // Verification step state
  const [verifying, setVerifying] = useState(false);
  const [verificationResult, setVerificationResult] =
    useState<VerificationResult | null>(null);

  // Wallet linking state
  const [linkingWallet, setLinkingWallet] = useState(false);

  // Profile lookup state (after sign-in, before we know the next step)
  const [profileLoading, setProfileLoading] = useState(false);

  // Derive current sub-step from auth/profile state.
  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setStep("auth");
      setProfileLoading(false);
      return;
    }

    let cancelled = false;

    async function determineStep() {
      const currentUser = user;
      if (!currentUser) return;
      setProfileLoading(true);
      try {
        const profile = await Promise.race([
          getUserProfile(currentUser.uid),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("Profile lookup timed out.")),
              PROFILE_LOOKUP_TIMEOUT_MS,
            ),
          ),
        ]);
        if (cancelled) return;

        console.log("[OnboardingWizard] loaded profile:", profile);

        if (!profile?.username) {
          console.log("[OnboardingWizard] no username -> username step");
          setStep("username");
        } else if (!profile?.walletAddress) {
          console.log("[OnboardingWizard] no wallet -> wallet step");
          setStep("wallet");
        } else if (
          !profile?.verifiedAt ||
          profile?.isVerifiedHuman !== true ||
          profile?.isOldEnoughWallet !== true
        ) {
          console.log(
            "[OnboardingWizard] not fully verified -> verify step",
            {
              verifiedAt: profile?.verifiedAt ?? null,
              isVerifiedHuman: profile?.isVerifiedHuman ?? null,
              isOldEnoughWallet: profile?.isOldEnoughWallet ?? null,
            },
          );
          setStep("verify");
        } else {
          console.log("[OnboardingWizard] fully verified -> redirect to /send");
          router.replace("/send");
        }
      } catch (err: any) {
        if (cancelled) return;
        console.error("[OnboardingWizard] Failed to load profile:", err);
        setError("Could not load your profile. Please refresh and try again.");
      } finally {
        if (!cancelled) setProfileLoading(false);
      }
    }

    void determineStep();

    return () => {
      cancelled = true;
    };
  }, [user, authLoading, router]);

  const clearError = useCallback(() => setError(null), []);

  async function handleGoogleSignIn() {
    clearError();
    const credential = await signInWithGoogle();
    if (!credential) {
      setError("Google sign-in failed. Please try again.");
      return;
    }
    setAuthName(credential.user.displayName ?? "");
  }

  async function handleEmailSignIn(e: React.FormEvent) {
    e.preventDefault();
    clearError();
    if (!email || !password) {
      setError("Please enter your email and password.");
      return;
    }
    const credential = await signInWithEmail(email, password);
    if (!credential) {
      setError("Email sign-in failed. Please check your credentials.");
    }
  }

  async function handleEmailSignUp(e: React.FormEvent) {
    e.preventDefault();
    clearError();
    if (!authName || !email || !password) {
      setError("Please fill in all fields.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    const credential = await signUpWithEmail(email, password, authName);
    if (!credential) {
      setError("Sign-up failed. Please try again.");
    }
  }

  async function handleUsernameSubmit(e: React.FormEvent) {
    e.preventDefault();
    clearError();

    if (!user) {
      setError("You must be signed in to choose a username.");
      return;
    }

    const trimmed = username.trim();
    if (trimmed.length < USERNAME_MIN_LENGTH || trimmed.length > USERNAME_MAX_LENGTH) {
      setError(
        `Username must be between ${USERNAME_MIN_LENGTH} and ${USERNAME_MAX_LENGTH} characters.`,
      );
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
      setError(
        "Username can only contain letters, numbers, underscores, and dashes.",
      );
      return;
    }

    const encodedUsername = encodeUsername(trimmed);
    if (!encodedUsername) {
      setError("Username is invalid after normalization.");
      return;
    }

    setCheckingUsername(true);
    try {
      const available = await isUsernameAvailable(trimmed);
      if (!available) {
        setError(`Username "${trimmed}" is already taken.`);
        return;
      }

      // Reserve the username and create the profile atomically via a secure
      // Cloud Function. This prevents race conditions, squatting, and stale
      // reservations if profile creation fails.
      await reserveUsernameAndCreateProfile({
        username: trimmed,
        email: user.email ?? undefined,
        displayName: user.displayName ?? undefined,
      });
      setStep("wallet");
    } catch (err: any) {
      console.error("Failed to save username:", err);
      if (err?.code === "functions/already-exists") {
        setError("That username was just taken; please choose another.");
      } else {
        setError(err.message ?? "Failed to save username.");
      }
    } finally {
      setCheckingUsername(false);
    }
  }

  async function handleConnectWallet() {
    clearError();
    if (!user) {
      console.log("[OnboardingWizard] handleConnectWallet: no Firebase user");
      setError("You must be signed in to link a wallet.");
      return;
    }
    console.log("[OnboardingWizard] handleConnectWallet: calling connect()");
    try {
      await connect();
      console.log("[OnboardingWizard] handleConnectWallet: connect() resolved");
    } catch (err: any) {
      console.error("[OnboardingWizard] handleConnectWallet: connect() failed", err);
      setError(err.message ?? "Wallet connection failed.");
    }
  }

  async function handleSignAndLinkWallet() {
    clearError();
    console.log("[OnboardingWizard] handleSignAndLinkWallet: started", {
      uid: user?.uid,
      address,
      hasSigner: !!signer,
    });

    if (!user || !address || !signer) {
      console.log("[OnboardingWizard] handleSignAndLinkWallet: missing user/address/signer");
      setError("Please connect your wallet before linking.");
      return;
    }

    setLinkingWallet(true);
    try {
      console.log("[OnboardingWizard] handleSignAndLinkWallet: fetching user profile");
      const profile = await getUserProfile(user.uid);
      console.log("[OnboardingWizard] handleSignAndLinkWallet: profile loaded", {
        profileWallet: profile?.walletAddress ?? null,
        currentAddress: address,
      });

      if (profile?.walletAddress) {
        if (profile.walletAddress.toLowerCase() !== address.toLowerCase()) {
          console.log("[OnboardingWizard] handleSignAndLinkWallet: address mismatch");
          setError(
            `This account is already linked to ${shortenAddress(profile.walletAddress)}. Switch MetaMask to that account, or sign in with a different Firebase account.`,
          );
          return;
        }
        console.log("[OnboardingWizard] handleSignAndLinkWallet: wallet already linked to this address -> advance to verify");
        setStep("verify");
        return;
      }

      const message = `Link wallet ${address.toLowerCase()} to KnockKnock account ${user.uid}`;
      console.log("[OnboardingWizard] handleSignAndLinkWallet: requesting MetaMask signature", { message });
      let signature: string;
      try {
        signature = await signer.signMessage(message);
      } catch (signErr: any) {
        console.error("[OnboardingWizard] handleSignAndLinkWallet: MetaMask sign rejected", signErr);
        setError(signErr.message ?? "Signature rejected in MetaMask.");
        return;
      }
      console.log("[OnboardingWizard] handleSignAndLinkWallet: MetaMask signature received", {
        signatureLength: signature.length,
      });

      console.log("[OnboardingWizard] handleSignAndLinkWallet: calling linkWallet Cloud Function");
      const result = await linkWallet({ walletAddress: address, signature });
      console.log("[OnboardingWizard] handleSignAndLinkWallet: linkWallet returned", result);

      if (!result?.success) {
        console.error("[OnboardingWizard] handleSignAndLinkWallet: linkWallet returned success=false");
        setError("Wallet linking was not accepted by the server.");
        return;
      }

      console.log("[OnboardingWizard] handleSignAndLinkWallet: advancing to verify step");
      setStep("verify");
    } catch (err: any) {
      console.error("[OnboardingWizard] handleSignAndLinkWallet: unexpected error", err);
      if (err?.code === "functions/permission-denied") {
        setError("Signature verification failed. Please sign with the connected account.");
      } else if (err?.code === "functions/already-exists") {
        setError("This wallet is already linked to another account.");
      } else {
        setError(err.message ?? "Failed to link wallet.");
      }
    } finally {
      console.log("[OnboardingWizard] handleSignAndLinkWallet: finally -> setLinkingWallet(false)");
      setLinkingWallet(false);
    }
  }

  useEffect(() => {
    async function advanceIfAlreadyLinked() {
      if (!user || !address || step !== "wallet") return;
      try {
        const profile = await getUserProfile(user.uid);
        if (profile?.walletAddress?.toLowerCase() === address.toLowerCase()) {
          setStep("verify");
        }
      } catch (err: any) {
        console.error("Failed to check linked wallet:", err);
      }
    }
    void advanceIfAlreadyLinked();
  }, [user, address, step]);

  function shortenAddress(address: string): string {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }

  async function handleVerifyIdentity() {
    clearError();

    if (!user) {
      setError("You must be signed in to verify your identity.");
      return;
    }
    if (!signer || !address) {
      setError("Please connect your wallet before verifying.");
      return;
    }
    if (chainId !== COSTON2_CHAIN_ID) {
      setError("Please switch your wallet to the Flare Coston2 network.");
      return;
    }

    setVerifying(true);
    try {
      const result = await runFCCVerification(signer, address);
      setVerificationResult(result);

      // The verified status is written by a secure Cloud Function that reads
      // the mailbox transaction on-chain. The client cannot forge these flags.
      const verification = await verifyOnboarding({ txHash: result.txHash });
      if (!verification.isVerifiedHuman) {
        setError(
          "Verification did not meet the required thresholds. You need a Human Passport score above 15.",
        );
        return;
      }

      // Identity verified — onboarding is complete. Route to the dashboard.
      setStep("complete");
    } catch (err: any) {
      console.error("Verification failed:", err);
      setError(err.reason ?? err.message ?? "Identity verification failed.");
    } finally {
      setVerifying(false);
    }
  }

  function handleComplete() {
    router.replace("/");
  }

  const displayedError = error || authError;
  const isAuthDisabled = authLoading || profileLoading;
  const disabledReason = authLoading
    ? "Authentication is initializing… the sign-in form will be enabled shortly."
    : profileLoading
      ? "Loading your profile…"
      : null;

  return (
    <>
    <div className="mx-auto max-w-2xl rounded-3xl border border-[#DFD0B8]/10 bg-[#393E46]/80 p-8 shadow-2xl shadow-black/30 backdrop-blur-sm sm:p-10">
      <StepIndicator current={step} />

      {/* key forces a fresh entrance animation on every step change */}
      <div key={step} className="animate-step-in text-center">
        {step === "auth" && (
          <AuthStep
            mode={authMode}
            setMode={setAuthMode}
            email={email}
            setEmail={setEmail}
            password={password}
            setPassword={setPassword}
            confirmPassword={confirmPassword}
            setConfirmPassword={setConfirmPassword}
            authName={authName}
            setAuthName={setAuthName}
            onGoogleSignIn={handleGoogleSignIn}
            onEmailSignIn={handleEmailSignIn}
            onEmailSignUp={handleEmailSignUp}
            disabled={isAuthDisabled}
            disabledReason={disabledReason}
          />
        )}

        {step === "username" && (
          <UsernameStep
            username={username}
            setUsername={setUsername}
            checking={checkingUsername}
            onSubmit={handleUsernameSubmit}
          />
        )}

        {step === "wallet" && (
          <WalletStep
            address={address}
            chainId={chainId}
            onConnect={handleConnectWallet}
            onSignAndLink={handleSignAndLinkWallet}
            linking={linkingWallet}
          />
        )}

        {step === "verify" && (
          <VerifyStep
            verifying={verifying}
            result={verificationResult}
            onVerify={handleVerifyIdentity}
          />
        )}

        {step === "complete" && (
          <CompleteStep onComplete={handleComplete} />
        )}
      </div>

      {displayedError && (
        <div className="mt-5 rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          {displayedError}
        </div>
      )}
    </div>

    <AnimatePresence>
      {(verifying || step === "complete") && (
        <VerificationLoader
          key="verification-loader"
          isSuccess={step === "complete"}
          onComplete={handleComplete}
        />
      )}
    </AnimatePresence>
    </>
  );
}

function StepIndicator({ current }: { current: OnboardingStep }) {
  const steps: { key: OnboardingStep; label: string }[] = [
    { key: "auth", label: "Sign In" },
    { key: "username", label: "Username" },
    { key: "wallet", label: "Wallet" },
    { key: "verify", label: "Verify" },
    { key: "complete", label: "Done" },
  ];

  const index = steps.findIndex((s) => s.key === current);
  const progress = (index / (steps.length - 1)) * 100;

  return (
    <div className="mb-10">
      <div className="flex items-center justify-between">
        {steps.map((s, i) => {
          const isActive = i <= index;
          const isCurrent = i === index;
          return (
            <div key={s.key} className="flex flex-1 flex-col items-center">
              <div
                className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold transition-all duration-300 ${
                  isCurrent
                    ? "bg-[#DFD0B8] text-[#222831] shadow-[0_0_18px_rgba(223,208,184,0.35)]"
                    : isActive
                      ? "border border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
                      : "border border-[#DFD0B8]/10 bg-[#222831] text-[#948979]"
                }`}
              >
                {isActive && !isCurrent ? (
                  <svg
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    className="h-4 w-4"
                    aria-hidden
                  >
                    <path
                      fillRule="evenodd"
                      d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 011.4-1.4l3.3 3.3 6.8-6.8a1 1 0 011.4 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                ) : (
                  i + 1
                )}
              </div>
              <span
                className={`mt-2 text-[11px] font-medium uppercase tracking-wider transition-colors ${
                  isCurrent ? "text-[#DFD0B8]" : "text-[#948979]"
                }`}
              >
                {s.label}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-[#222831]">
        <div
          className="h-full rounded-full bg-gradient-to-r from-[#948979] to-[#DFD0B8] transition-all duration-500 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}

interface AuthStepProps {
  mode: "google" | "email" | "signup";
  setMode: (mode: "google" | "email" | "signup") => void;
  email: string;
  setEmail: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  confirmPassword: string;
  setConfirmPassword: (v: string) => void;
  authName: string;
  setAuthName: (v: string) => void;
  onGoogleSignIn: () => void;
  onEmailSignIn: (e: React.FormEvent) => Promise<void>;
  onEmailSignUp: (e: React.FormEvent) => Promise<void>;
  disabled?: boolean;
  disabledReason?: string | null;
}

function AuthStep({
  mode,
  setMode,
  email,
  setEmail,
  password,
  setPassword,
  confirmPassword,
  setConfirmPassword,
  authName,
  setAuthName,
  onGoogleSignIn,
  onEmailSignIn,
  onEmailSignUp,
  disabled = false,
  disabledReason = null,
}: AuthStepProps) {
  return (
    <div>
      <h2 className="text-3xl font-bold tracking-tight text-[#DFD0B8] sm:text-4xl">
        Welcome to KnockKnock
      </h2>
      <p className="mt-3 text-sm leading-relaxed text-[#948979]">
        Sign in to create your secure, privacy-first Web3 messaging profile on Flare.
      </p>

      {disabled && disabledReason && (
        <p className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-300">
          {disabledReason}
        </p>
      )}

      <div className="mt-7 grid grid-cols-3 gap-2 rounded-2xl border border-[#DFD0B8]/10 bg-[#222831] p-1.5">
        {(
          [
            ["google", "Google"],
            ["email", "Email"],
            ["signup", "Sign Up"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setMode(key)}
            disabled={disabled}
            className={`rounded-xl px-3 py-2 text-sm font-semibold transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-60 ${
              mode === key
                ? "bg-[#DFD0B8] text-[#222831] shadow-sm"
                : "text-[#948979] hover:text-[#DFD0B8]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "google" && (
        <button
          type="button"
          onClick={onGoogleSignIn}
          disabled={disabled}
          className="mt-5 flex w-full items-center justify-center gap-3 rounded-2xl border border-[#DFD0B8]/15 bg-[#222831] px-5 py-3.5 font-semibold text-[#DFD0B8] shadow-lg shadow-black/20 transition-all duration-300 hover:-translate-y-0.5 hover:border-[#DFD0B8]/30 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span className="text-lg">G</span>
          Sign in with Google
        </button>
      )}

      {mode === "email" && (
        <form onSubmit={onEmailSignIn} className="mt-5 flex flex-col gap-4">
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={disabled}
            className="w-full rounded-xl border border-[#948979]/40 bg-[#222831] px-4 py-3 text-sm text-[#DFD0B8] placeholder:text-[#948979]/60 focus:border-[#DFD0B8] focus:outline-none focus:ring-1 focus:ring-[#DFD0B8]/40 disabled:cursor-not-allowed disabled:opacity-60"
            required
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={disabled}
            className="w-full rounded-xl border border-[#948979]/40 bg-[#222831] px-4 py-3 text-sm text-[#DFD0B8] placeholder:text-[#948979]/60 focus:border-[#DFD0B8] focus:outline-none focus:ring-1 focus:ring-[#DFD0B8]/40 disabled:cursor-not-allowed disabled:opacity-60"
            required
          />
          <button
            type="submit"
            disabled={disabled}
            className="w-full rounded-2xl bg-gradient-to-b from-[#DFD0B8] to-[#c9b89a] px-5 py-3.5 font-bold text-[#222831] shadow-lg shadow-[#DFD0B8]/15 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[#DFD0B8]/25 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Sign In
          </button>
        </form>
      )}

      {mode === "signup" && (
        <form onSubmit={onEmailSignUp} className="mt-5 flex flex-col gap-4">
          <input
            type="text"
            placeholder="Display name"
            value={authName}
            onChange={(e) => setAuthName(e.target.value)}
            disabled={disabled}
            className="w-full rounded-xl border border-[#948979]/40 bg-[#222831] px-4 py-3 text-sm text-[#DFD0B8] placeholder:text-[#948979]/60 focus:border-[#DFD0B8] focus:outline-none focus:ring-1 focus:ring-[#DFD0B8]/40 disabled:cursor-not-allowed disabled:opacity-60"
            required
          />
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={disabled}
            className="w-full rounded-xl border border-[#948979]/40 bg-[#222831] px-4 py-3 text-sm text-[#DFD0B8] placeholder:text-[#948979]/60 focus:border-[#DFD0B8] focus:outline-none focus:ring-1 focus:ring-[#DFD0B8]/40 disabled:cursor-not-allowed disabled:opacity-60"
            required
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={disabled}
            className="w-full rounded-xl border border-[#948979]/40 bg-[#222831] px-4 py-3 text-sm text-[#DFD0B8] placeholder:text-[#948979]/60 focus:border-[#DFD0B8] focus:outline-none focus:ring-1 focus:ring-[#DFD0B8]/40 disabled:cursor-not-allowed disabled:opacity-60"
            required
          />
          <input
            type="password"
            placeholder="Confirm password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={disabled}
            className="w-full rounded-xl border border-[#948979]/40 bg-[#222831] px-4 py-3 text-sm text-[#DFD0B8] placeholder:text-[#948979]/60 focus:border-[#DFD0B8] focus:outline-none focus:ring-1 focus:ring-[#DFD0B8]/40 disabled:cursor-not-allowed disabled:opacity-60"
            required
          />
          <button
            type="submit"
            disabled={disabled}
            className="w-full rounded-2xl bg-gradient-to-b from-[#DFD0B8] to-[#c9b89a] px-5 py-3.5 font-bold text-[#222831] shadow-lg shadow-[#DFD0B8]/15 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[#DFD0B8]/25 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Create Account
          </button>
        </form>
      )}
    </div>
  );
}

interface UsernameStepProps {
  username: string;
  setUsername: (v: string) => void;
  checking: boolean;
  onSubmit: (e: React.FormEvent) => Promise<void>;
}

function UsernameStep({
  username,
  setUsername,
  checking,
  onSubmit,
}: UsernameStepProps) {
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      <div>
        <h2 className="text-3xl font-bold tracking-tight text-[#DFD0B8] sm:text-4xl">
          Choose your handle
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-[#948979]">
          This is how other KnockKnock users will find and message you. Pick
          something memorable — it&apos;s yours permanently.
        </p>
      </div>
      <input
        type="text"
        placeholder="knock_user"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        className="w-full rounded-xl border border-[#948979]/40 bg-[#222831] px-4 py-3.5 text-base text-[#DFD0B8] placeholder:text-[#948979]/60 focus:border-[#DFD0B8] focus:outline-none focus:ring-1 focus:ring-[#DFD0B8]/40"
        minLength={USERNAME_MIN_LENGTH}
        maxLength={USERNAME_MAX_LENGTH}
        required
      />
      <button
        type="submit"
        disabled={checking}
        className="w-full rounded-2xl bg-gradient-to-b from-[#DFD0B8] to-[#c9b89a] px-5 py-3.5 font-bold text-[#222831] shadow-lg shadow-[#DFD0B8]/15 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[#DFD0B8]/25 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {checking ? "Checking..." : "Continue"}
      </button>
    </form>
  );
}

interface WalletStepProps {
  address: string | null;
  chainId: number | null;
  onConnect: () => void;
  onSignAndLink: () => Promise<void>;
  linking: boolean;
}

function WalletStep({
  address,
  chainId,
  onConnect,
  onSignAndLink,
  linking,
}: WalletStepProps) {
  const isCorrectNetwork = chainId === COSTON2_CHAIN_ID;
  const canLink = address && isCorrectNetwork;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-3xl font-bold tracking-tight text-[#DFD0B8] sm:text-4xl">
          Connect your Flare wallet
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-[#948979]">
          Link your MetaMask address to your KnockKnock profile. This address
          will be used to send and receive private chat requests on Flare Coston2.
        </p>
      </div>

      {address ? (
        <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 px-5 py-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-emerald-300">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 animate-pulse-ring" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
            </span>
            Wallet connected
          </div>
          <p className="mt-2 break-all font-mono text-xs text-emerald-200/80">
            {address}
          </p>
          {!isCorrectNetwork && (
            <p className="mt-3 text-sm font-semibold text-rose-300">
              Please switch to Flare Coston2 in MetaMask.
            </p>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={onConnect}
          className="w-full rounded-2xl bg-gradient-to-b from-[#DFD0B8] to-[#c9b89a] px-5 py-3.5 font-bold text-[#222831] shadow-lg shadow-[#DFD0B8]/15 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[#DFD0B8]/25"
        >
          Connect Wallet
        </button>
      )}

      {canLink && (
        <button
          type="button"
          onClick={onSignAndLink}
          disabled={linking}
          className="flex w-full items-center justify-center gap-2 rounded-2xl border border-[#DFD0B8]/20 bg-[#222831] px-5 py-3.5 font-bold text-[#DFD0B8] shadow-lg shadow-black/20 transition-all duration-300 hover:-translate-y-0.5 hover:border-[#DFD0B8]/40 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {linking && (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#DFD0B8] border-t-transparent" />
          )}
          {linking ? "Linking wallet..." : "Sign to link wallet"}
        </button>
      )}
    </div>
  );
}

interface VerifyStepProps {
  verifying: boolean;
  result: VerificationResult | null;
  onVerify: () => void;
}

function VerifyStep({ verifying, result, onVerify }: VerifyStepProps) {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-3xl font-bold tracking-tight text-[#DFD0B8] sm:text-4xl">
          Verify your identity
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-[#948979]">
          KnockKnock checks your Gitcoin Passport score and wallet age inside
          the Flare Confidential Compute TEE. No personal data leaves the
          enclave.
        </p>
      </div>

      {result ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-2xl border border-emerald-500/25 bg-emerald-500/10 px-5 py-3.5">
            <span className="flex items-center gap-2 text-sm font-semibold text-emerald-300">
              ✅ Verified Human
            </span>
            <span className="text-sm font-bold text-emerald-200">
              {result.isVerifiedHuman ? "Yes" : "No"}
            </span>
          </div>
          <div className="flex items-center justify-between rounded-2xl border border-emerald-500/25 bg-emerald-500/10 px-5 py-3.5">
            <span className="flex items-center gap-2 text-sm font-semibold text-emerald-300">
              ✅ Wallet Age
            </span>
            <span className="text-sm font-bold text-emerald-200">
              {result.isOldEnoughWallet ? "Old enough" : "Too new"}
            </span>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={onVerify}
          disabled={verifying}
          className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-b from-[#DFD0B8] to-[#c9b89a] px-5 py-3.5 font-bold text-[#222831] shadow-lg shadow-[#DFD0B8]/15 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[#DFD0B8]/25 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {verifying && (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#222831] border-t-transparent" />
          )}
          {verifying ? "Verifying with TEE..." : "Verify Identity"}
        </button>
      )}
    </div>
  );
}

function CompleteStep({ onComplete }: { onComplete: () => void }) {
  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <div className="animate-pop flex h-20 w-20 items-center justify-center rounded-full bg-emerald-500/15 text-4xl ring-1 ring-emerald-400/30">
        🎉
      </div>
      <h2 className="text-3xl font-bold tracking-tight text-[#DFD0B8] sm:text-4xl">
        You&apos;re all set!
      </h2>
      <p className="max-w-sm text-sm leading-relaxed text-[#948979]">
        Your identity is verified and your profile is ready. Start sending
        private knocks on Flare.
      </p>
      <button
        type="button"
        onClick={onComplete}
        className="w-full rounded-2xl bg-gradient-to-b from-[#DFD0B8] to-[#c9b89a] px-6 py-3.5 font-bold text-[#222831] shadow-lg shadow-[#DFD0B8]/15 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[#DFD0B8]/25"
      >
        Start Messaging
      </button>
    </div>
  );
}

