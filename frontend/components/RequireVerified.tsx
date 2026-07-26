"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useFirebaseAuth } from "@/context/FirebaseAuthContext";
import { getUserProfile } from "@/lib/firebaseProfile";

interface RequireVerifiedProps {
  children: React.ReactNode;
}

/**
 * Client-side guard that redirects unauthenticated or unverified users to
 * /onboard. This complements the lightweight cookie-based middleware redirect.
 */
export default function RequireVerified({ children }: RequireVerifiedProps) {
  const router = useRouter();
  const { user, loading: authLoading } = useFirebaseAuth();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (authLoading) {
      console.log("[RequireVerified] waiting for Firebase auth state...");
      return;
    }

    async function checkProfile() {
      if (!user) {
        console.log("[RequireVerified] no Firebase user; redirecting to /onboard");
        router.replace("/onboard");
        return;
      }

      console.log(`[RequireVerified] Firebase user present: ${user.uid}`);

      try {
        const profile = await getUserProfile(user.uid);
        console.log("[RequireVerified] profile loaded:", profile);

        const hasVerifiedAt = Boolean(profile?.verifiedAt);
        const hasWallet = Boolean(profile?.walletAddress);
        const isVerifiedHuman = profile?.isVerifiedHuman === true;
        const isOldEnoughWallet = profile?.isOldEnoughWallet === true;

        console.log("[RequireVerified] checks:", {
          hasVerifiedAt,
          hasWallet,
          isVerifiedHuman,
          isOldEnoughWallet,
          verifiedAt: profile?.verifiedAt ?? null,
        });

        const isVerified =
          hasVerifiedAt && hasWallet && isVerifiedHuman && isOldEnoughWallet;

        if (!isVerified) {
          console.log(
            "[RequireVerified] user is not fully verified; redirecting to /onboard",
          );
          router.replace("/onboard");
          return;
        }

        console.log("[RequireVerified] user is verified; rendering protected route");
        setChecking(false);
      } catch (err) {
        console.error("[RequireVerified] Failed to check verification status:", err);
        router.replace("/onboard");
      }
    }

    void checkProfile();
  }, [user, authLoading, router]);

  if (authLoading || checking) {
    return (
      <div className="flex h-96 items-center justify-center">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-slate-200 border-t-brand-600" />
      </div>
    );
  }

  return <>{children}</>;
}
