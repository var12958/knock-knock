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

const USERNAME_MIN_LENGTH = 3;
const USERNAME_MAX_LENGTH = 24;
const PROFILE_LOOKUP_TIMEOUT_MS = 5000;

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
        if (!profile?.username) {
          setStep("username");
        } else if (!profile?.walletAddress) {
          setStep("wallet");
        } else if (
          !profile?.verifiedAt ||
          profile?.isVerifiedHuman !== true ||
          profile?.isOldEnoughWallet !== true
        ) {
          setStep("verify");
        } else {
          router.replace("/send");
        }
      } catch (err: any) {
        if (cancelled) return;
        console.error("Failed to load profile:", err);
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
      setError("You must be signed in to link a wallet.");
      return;
    }
    try {
      await connect();
    } catch (err: any) {
      setError(err.message ?? "Wallet connection failed.");
    }
  }

  async function handleSignAndLinkWallet() {
    clearError();
    if (!user || !address || !signer) {
      setError("Please connect your wallet before linking.");
      return;
    }

    setLinkingWallet(true);
    try {
      const profile = await getUserProfile(user.uid);
      if (profile?.walletAddress) {
        if (profile.walletAddress.toLowerCase() !== address.toLowerCase()) {
          setError(
            `This account is already linked to ${shortenAddress(profile.walletAddress)}. Switch MetaMask to that account, or sign in with a different Firebase account.`,
          );
          return;
        }
        setStep("verify");
        return;
      }

      const message = `Link wallet ${address.toLowerCase()} to KnockKnock account ${user.uid}`;
      const signature = await signer.signMessage(message);
      await linkWallet({ walletAddress: address, signature });
      setStep("verify");
    } catch (err: any) {
      console.error("Failed to link wallet:", err);
      if (err?.code === "functions/permission-denied") {
        setError("Signature verification failed. Please sign with the connected account.");
      } else if (err?.code === "functions/already-exists") {
        setError("This wallet is already linked to another account.");
      } else {
        setError(err.message ?? "Failed to link wallet.");
      }
    } finally {
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

      setStep("complete");
    } catch (err: any) {
      console.error("Verification failed:", err);
      setError(err.reason ?? err.message ?? "Identity verification failed.");
    } finally {
      setVerifying(false);
    }
  }

  function handleComplete() {
    router.replace("/send");
  }

  const displayedError = error || authError;
  const isAuthDisabled = authLoading || profileLoading;
  const disabledReason = authLoading
    ? "Authentication is initializing… the sign-in form will be enabled shortly."
    : profileLoading
      ? "Loading your profile…"
      : null;

  return (
    <div className="mx-auto max-w-xl rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
      <StepIndicator current={step} />

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

      {displayedError && (
        <div className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          {displayedError}
        </div>
      )}
    </div>
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

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between">
        {steps.map((s, i) => {
          const isActive = i <= index;
          const isCurrent = i === index;
          return (
            <div key={s.key} className="flex flex-1 flex-col items-center">
              <div
                className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold ${
                  isCurrent
                    ? "bg-brand-600 text-white"
                    : isActive
                      ? "bg-green-100 text-green-700"
                      : "bg-slate-100 text-slate-400"
                }`}
              >
                {isActive && !isCurrent ? "✓" : i + 1}
              </div>
              <span
                className={`mt-2 text-xs ${
                  isCurrent ? "font-medium text-slate-800" : "text-slate-500"
                }`}
              >
                {s.label}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-3 h-1 rounded bg-slate-100">
        <div
          className="h-1 rounded bg-brand-600 transition-all"
          style={{ width: `${(index / (steps.length - 1)) * 100}%` }}
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
      <h2 className="mb-2 text-2xl font-bold text-slate-800">Welcome to KnockKnock 👋</h2>
      <p className="mb-6 text-slate-600">
        Sign in to create your secure Web3 messaging profile.
      </p>

      {disabled && disabledReason && (
        <p className="mb-4 rounded-lg bg-amber-50 px-4 py-2 text-sm text-amber-700">
          {disabledReason}
        </p>
      )}

      <div className="mb-6 grid grid-cols-3 gap-2">
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
            className={`rounded-lg px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60 ${
              mode === key
                ? "bg-brand-100 text-brand-700 ring-1 ring-brand-300"
                : "bg-slate-50 text-slate-600 hover:bg-slate-100"
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
          className="flex w-full items-center justify-center gap-3 rounded-lg border border-slate-300 bg-white px-5 py-3 font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span className="text-lg">G</span>
          Sign in with Google
        </button>
      )}

      {mode === "email" && (
        <form onSubmit={onEmailSignIn} className="flex flex-col gap-4">
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={disabled}
            className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:opacity-60"
            required
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={disabled}
            className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:opacity-60"
            required
          />
          <button
            type="submit"
            disabled={disabled}
            className="rounded-lg bg-brand-600 px-5 py-3 font-medium text-white shadow transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Sign In
          </button>
        </form>
      )}

      {mode === "signup" && (
        <form onSubmit={onEmailSignUp} className="flex flex-col gap-4">
          <input
            type="text"
            placeholder="Display name"
            value={authName}
            onChange={(e) => setAuthName(e.target.value)}
            disabled={disabled}
            className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:opacity-60"
            required
          />
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={disabled}
            className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:opacity-60"
            required
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={disabled}
            className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:opacity-60"
            required
          />
          <input
            type="password"
            placeholder="Confirm password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={disabled}
            className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:opacity-60"
            required
          />
          <button
            type="submit"
            disabled={disabled}
            className="rounded-lg bg-brand-600 px-5 py-3 font-medium text-white shadow transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
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
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <h2 className="text-2xl font-bold text-slate-800">Choose a username</h2>
      <p className="text-slate-600">
        This is how other KnockKnock users will see you.
      </p>
      <input
        type="text"
        placeholder="knock_user"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
        minLength={USERNAME_MIN_LENGTH}
        maxLength={USERNAME_MAX_LENGTH}
        required
      />
      <button
        type="submit"
        disabled={checking}
        className="rounded-lg bg-brand-600 px-5 py-3 font-medium text-white shadow transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
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
    <div className="flex flex-col gap-4">
      <h2 className="text-2xl font-bold text-slate-800">Connect your Flare wallet</h2>
      <p className="text-slate-600">
        Link your MetaMask address to your KnockKnock profile. This address will
        be used to send and receive private chat requests on Flare Coston2.
      </p>

      {address ? (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3">
          <p className="text-sm font-medium text-green-800">Wallet connected</p>
          <p className="mt-1 break-all text-sm text-green-700">{address}</p>
          {!isCorrectNetwork && (
            <p className="mt-2 text-sm font-semibold text-red-600">
              Please switch to Flare Coston2 in MetaMask.
            </p>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={onConnect}
          className="rounded-lg bg-brand-600 px-5 py-3 font-medium text-white shadow transition hover:bg-brand-700"
        >
          Connect MetaMask
        </button>
      )}

      {canLink && (
        <button
          type="button"
          onClick={onSignAndLink}
          disabled={linking}
          className="flex items-center justify-center gap-2 rounded-lg bg-brand-600 px-5 py-3 font-medium text-white shadow transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {linking && (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
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
    <div className="flex flex-col gap-4">
      <h2 className="text-2xl font-bold text-slate-800">Verify your identity</h2>
      <p className="text-slate-600">
        KnockKnock checks your Gitcoin Passport score and wallet age inside the
        Flare Confidential Compute TEE. No personal data leaves the enclave.
      </p>

      {result ? (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3">
          <div className="flex items-center gap-2 text-green-800">
            <span>✅ Verified Human</span>
            <span className="text-sm">{result.isVerifiedHuman ? "Yes" : "No"}</span>
          </div>
          <div className="mt-2 flex items-center gap-2 text-green-800">
            <span>✅ Wallet Age</span>
            <span className="text-sm">
              {result.isOldEnoughWallet ? "Old enough" : "Too new"}
            </span>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={onVerify}
          disabled={verifying}
          className="flex items-center justify-center gap-2 rounded-lg bg-brand-600 px-5 py-3 font-medium text-white shadow transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {verifying && (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
          )}
          {verifying ? "Verifying with TEE..." : "Verify Identity"}
        </button>
      )}
    </div>
  );
}

function CompleteStep({ onComplete }: { onComplete: () => void }) {
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <div className="flex h-20 w-20 items-center justify-center rounded-full bg-green-100 text-4xl">
        🎉
      </div>
      <h2 className="text-2xl font-bold text-slate-800">You&apos;re all set!</h2>
      <p className="text-slate-600">
        Your identity is verified and your profile is ready. Start sending
        private knocks on Flare.
      </p>
      <button
        type="button"
        onClick={onComplete}
        className="rounded-lg bg-brand-600 px-6 py-3 font-medium text-white shadow transition hover:bg-brand-700"
      >
        Start Messaging
      </button>
    </div>
  );
}
