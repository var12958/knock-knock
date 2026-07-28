"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useWeb3 } from "@/context/Web3Context";
import { useFirebaseAuth } from "@/context/FirebaseAuthContext";
import { getUserProfile } from "@/lib/firebaseProfile";
import { COSTON2_CHAIN_ID } from "@/lib/chain";

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export default function Web3Header() {
  const { address, chainId, isConnecting, error, connect, disconnect } = useWeb3();
  const { user } = useFirebaseAuth();
  const [username, setUsername] = useState<string | null>(null);
  const [usernameLoading, setUsernameLoading] = useState(false);
  const isCorrectNetwork = chainId === COSTON2_CHAIN_ID;

  useEffect(() => {
    if (!user?.uid) {
      setUsername(null);
      setUsernameLoading(false);
      return;
    }

    let cancelled = false;
    setUsernameLoading(true);

    getUserProfile(user.uid)
      .then((profile) => {
        if (!cancelled) {
          setUsername(profile?.username ?? null);
        }
      })
      .catch((err) => {
        console.error("[Web3Header] Failed to load username:", err);
      })
      .finally(() => {
        if (!cancelled) {
          setUsernameLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [user?.uid]);

  const hasUsername = Boolean(username && username.trim());
  const displayName = hasUsername
    ? (username ?? "").toUpperCase()
    : address
      ? shortenAddress(address)
      : "";

  return (
    <header className="sticky top-0 z-50 w-full border-b border-[#DFD0B8]/10 bg-[#222831]/80 px-4 py-4 shadow-[0_8px_30px_rgba(0,0,0,0.25)] backdrop-blur-xl sm:px-6 lg:px-8">
      {/* Hairline gradient accent under the header */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-[#DFD0B8]/25 to-transparent"
      />
      <div className="relative mx-auto flex max-w-7xl items-center justify-between">
        <Link href="/" className="group flex items-center gap-4">
          <div className="relative h-11 w-11 overflow-hidden rounded-xl ring-1 ring-[#DFD0B8]/20 transition-all duration-300 group-hover:ring-[#DFD0B8]/40 group-hover:shadow-[0_0_20px_rgba(223,208,184,0.15)]">
            <Image
              src="/logo.png"
              alt="KnockKnock"
              fill
              className="object-cover"
              priority
            />
          </div>
          <div className="hidden flex-col sm:flex">
            <h1 className="text-lg font-bold tracking-tight text-[#DFD0B8]">
              KnockKnock
            </h1>
            <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-[#948979]">
              Privacy-first Web3 messaging
            </span>
          </div>
        </Link>

        <div className="flex items-center gap-3">
          {address ? (
            <div className="flex items-center gap-3 rounded-2xl border border-[#DFD0B8]/10 bg-[#393E46] px-4 py-2.5 shadow-lg shadow-black/20 transition-all duration-300 hover:border-[#DFD0B8]/20">
              <div className="hidden flex-col items-end sm:flex">
                <span className="text-sm font-bold tracking-wide text-[#DFD0B8]">
                  {usernameLoading ? "..." : displayName}
                </span>
                {hasUsername && address && (
                  <span className="text-xs text-[#948979]">
                    {shortenAddress(address)}
                  </span>
                )}
              </div>

              <div className="flex flex-col items-end gap-1.5">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-[#DFD0B8]/20 bg-[#222831] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-[#DFD0B8]">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 animate-pulse-ring" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]" />
                  </span>
                  Verified
                </span>
                <span
                  className={`text-[10px] font-medium ${
                    isCorrectNetwork ? "text-[#948979]" : "text-rose-400"
                  }`}
                >
                  {isCorrectNetwork ? "Coston2" : `Wrong network (${chainId ?? "unknown"})`}
                </span>
              </div>

              <button
                onClick={disconnect}
                className="ml-2 rounded-lg border border-[#DFD0B8]/10 px-3 py-1.5 text-xs font-semibold text-[#948979] transition-all duration-200 hover:border-[#DFD0B8]/30 hover:bg-[#222831] hover:text-[#DFD0B8]"
                title="Disconnect wallet"
              >
                Disconnect
              </button>
            </div>
          ) : (
            <button
              onClick={connect}
              disabled={isConnecting}
              className="rounded-2xl bg-[#DFD0B8] px-6 py-2.5 text-sm font-bold text-[#222831] shadow-lg shadow-[#DFD0B8]/10 transition-all duration-300 hover:-translate-y-0.5 hover:bg-[#DFD0B8]/90 hover:shadow-[#DFD0B8]/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isConnecting ? "Connecting..." : "Connect MetaMask"}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mx-auto mt-3 max-w-7xl rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-2 text-sm text-rose-300 ring-1 ring-rose-500/10">
          {error}
        </div>
      )}
    </header>
  );
}
