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
    if (authLoading) return;

    async function checkProfile() {
      if (!user) {
        router.replace("/onboard");
        return;
      }

      try {
        const profile = await getUserProfile(user.uid);
        const isVerified =
          Boolean(profile?.verifiedAt) &&
          Boolean(profile?.walletAddress) &&
          profile?.isVerifiedHuman === true &&
          profile?.isOldEnoughWallet === true;

        if (!isVerified) {
          router.replace("/onboard");
          return;
        }
        setChecking(false);
      } catch (err) {
        console.error("Failed to check verification status:", err);
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
