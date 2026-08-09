"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useFirebaseAuth } from "@/context/FirebaseAuthContext";
import { useWeb3 } from "@/context/Web3Context";
import { getUserProfile } from "@/lib/firebaseProfile";

interface RequireVerifiedProps {
  children: React.ReactNode;
}

/**
 * Client-side guard that redirects unauthenticated or unverified users to
 * /onboard. This complements the lightweight cookie-based middleware redirect.
 *
 * When the user switches MetaMask accounts, Web3Context runs silent re-verification
 * in the background and exposes `isSwitchingAccount`. While that is true we keep
 * showing a spinner so the user is not kicked to /onboard before the new wallet has
 * a chance to be verified and linked.
 */
export default function RequireVerified({ children }: RequireVerifiedProps) {
  const router = useRouter();
  const { user, loading: authLoading } = useFirebaseAuth();
  const { address, isSwitchingAccount } = useWeb3();
  const [checking, setChecking] = useState(true);

  // As soon as Web3Context starts switching accounts, go back to a loading
  // state so protected content is never rendered while re-verification runs.
  useEffect(() => {
    if (isSwitchingAccount) {
      setChecking(true);
    }
  }, [isSwitchingAccount]);

  // Ignore stale profile checks when the user switches accounts rapidly: only
  // the most recently triggered check may flip `checking` to false.
  const checkNonceRef = useRef(0);

  useEffect(() => {
    if (authLoading || isSwitchingAccount) {
      if (isSwitchingAccount) {
        console.log("[RequireVerified] waiting for account switch verification...");
      } else {
        console.log("[RequireVerified] waiting for Firebase auth state...");
      }
      return;
    }

    const currentCheck = ++checkNonceRef.current;

    async function checkProfile() {
      if (currentCheck !== checkNonceRef.current) return;

      if (!user) {
        console.log("[RequireVerified] no Firebase user; redirecting to /onboard");
        router.replace("/onboard");
        return;
      }

      console.log(`[RequireVerified] Firebase user present: ${user.uid}`);

      try {
        const profile = await getUserProfile(user.uid);
        if (currentCheck !== checkNonceRef.current) return;
        console.log("[RequireVerified] profile loaded:", profile);

        const hasVerifiedAt = Boolean(profile?.verifiedAt);
        const hasWallet = Boolean(profile?.walletAddress);
        const isVerifiedHuman = profile?.isVerifiedHuman === true;
        const isOldEnoughWallet = profile?.isOldEnoughWallet === true;
        // If a wallet is connected, it must match the address stored in the
        // Firebase profile. This catches account switches before the silent
        // re-verification has completed and written the new walletAddress.
        const walletMatches =
          !address ||
          profile?.walletAddress?.toLowerCase() === address.toLowerCase();

        console.log("[RequireVerified] checks:", {
          hasVerifiedAt,
          hasWallet,
          isVerifiedHuman,
          isOldEnoughWallet,
          walletMatches,
          verifiedAt: profile?.verifiedAt ?? null,
        });

        // Verified human profiles can always render protected routes, even
        // while the Web3 wallet is still loading or the active wallet differs.
        // This breaks the /onboard <-> /send redirect loop caused by wallet
        // state taking a moment to catch up after page load.
        if (hasVerifiedAt && isVerifiedHuman) {
          console.log(
            "[RequireVerified] verified human profile found; rendering protected route",
          );
          if (currentCheck === checkNonceRef.current) {
            setChecking(false);
          }
          return;
        }

        const isVerified =
          hasVerifiedAt && hasWallet && isVerifiedHuman && isOldEnoughWallet && walletMatches;

        if (!isVerified) {
          console.log(
            "[RequireVerified] user is not fully verified; redirecting to /onboard",
          );
          router.replace("/onboard");
          return;
        }

        console.log("[RequireVerified] user is verified; rendering protected route");
        if (currentCheck === checkNonceRef.current) {
          setChecking(false);
        }
      } catch (err) {
        if (currentCheck !== checkNonceRef.current) return;
        console.error("[RequireVerified] Failed to check verification status:", err);
        router.replace("/onboard");
      }
    }

    void checkProfile();
  }, [user, authLoading, router, address, isSwitchingAccount]);

  if (authLoading || checking || isSwitchingAccount) {
    return (
      <div className="flex h-96 items-center justify-center">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-slate-200 border-t-brand-600" />
      </div>
    );
  }

  return <>{children}</>;
}
