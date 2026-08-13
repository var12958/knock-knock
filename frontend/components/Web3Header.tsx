"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useSearchParams } from "next/navigation";
import { useWeb3 } from "@/context/Web3Context";
import { useFirebaseAuth } from "@/context/FirebaseAuthContext";
import { getUserProfile } from "@/lib/firebaseProfile";
import { COSTON2_ADD_PROMPT, COSTON2_CHAIN_ID } from "@/lib/chain";

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function Web3HeaderContent() {
  const { address, chainId, isConnecting, error, connect, disconnect } =
    useWeb3();
  const { user } = useFirebaseAuth();
  const pathname = usePathname() ?? "/";
  const searchParams = useSearchParams();

  const [username, setUsername] = useState<string | null>(null);
  const [usernameLoading, setUsernameLoading] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  const profileRef = useRef<HTMLDivElement | null>(null);
  const isCorrectNetwork = chainId === COSTON2_CHAIN_ID;

  const activeTab = searchParams.get("view") ?? "inbox";

  const isInChatRoom =
    /^\/chat\//.test(pathname) && !pathname.startsWith("/chat/group/");

  useEffect(() => {
    console.log("[Web3Header] auth effect: user?.uid=", user?.uid);

    if (!user?.uid) {
      console.log("[Web3Header] no uid, clearing username");
      setUsername(null);
      setUsernameLoading(false);
      return;
    }

    let cancelled = false;
    setUsernameLoading(true);

    getUserProfile(user.uid)
      .then((profile) => {
        console.log(
          "[Web3Header] getUserProfile resolved for uid=",
          user.uid,
          "profile=",
          profile,
        );

        if (!cancelled) {
          const resolvedName =
            profile?.displayName || profile?.username || null;

          console.log(
            "[Web3Header] resolved displayName/username to:",
            resolvedName,
          );

          setUsername(resolvedName);
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

  // Close the profile dropdown when clicking outside the chip.
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        profileRef.current &&
        !profileRef.current.contains(event.target as Node)
      ) {
        setProfileOpen(false);
      }
    }

    if (profileOpen) {
      document.addEventListener("mousedown", handleClickOutside);

      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [profileOpen]);

  const hasUsername = Boolean(username && username.trim());

  const displayName = hasUsername
    ? (username ?? "").toUpperCase()
    : address
      ? shortenAddress(address)
      : "";

  console.log(
    "[Web3Header] render: username=",
    username,
    "hasUsername=",
    hasUsername,
    "displayName=",
    displayName,
    "address=",
    address,
    "usernameLoading=",
    usernameLoading,
  );

  return (
    <header className="sticky top-0 z-50 w-full border-b border-[#DFD0B8]/10 bg-[#222831]/80 px-4 py-4 shadow-[0_8px_30px_rgba(0,0,0,0.25)] backdrop-blur-xl sm:px-6 lg:px-8">
      {/* Hairline gradient accent under the header */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-[#DFD0B8]/25 to-transparent"
      />

      <div className="relative mx-auto grid max-w-7xl grid-cols-[auto_1fr_auto] items-center gap-4">
        <Link
          href="/"
          className="group flex items-center gap-4 justify-self-start"
        >
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

        {address && isInChatRoom && (
          <nav className="hidden items-center justify-center gap-1 justify-self-center rounded-xl border border-[#DFD0B8]/10 bg-[#222831]/60 p-1 md:flex">
            {[
              { key: "inbox", label: "Inbox" },
              { key: "chats", label: "Chats" },
              { key: "history", label: "History" },
            ].map((tab) => (
              <Link
                key={tab.key}
                href={`/?view=${tab.key}`}
                className={`rounded-lg px-4 py-1.5 text-sm font-semibold transition-colors duration-200 ${
                  activeTab === tab.key
                    ? "bg-[#DFD0B8] text-[#222831]"
                    : "text-[#948979] hover:text-[#DFD0B8]"
                }`}
              >
                {tab.label}
              </Link>
            ))}
          </nav>
        )}

        <div className="ml-auto flex items-center justify-end gap-3 justify-self-end">
          {address ? (
            <div ref={profileRef} className="relative">
              <button
                type="button"
                onClick={() => setProfileOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={profileOpen}
                className="flex items-center gap-3 rounded-2xl border border-[#DFD0B8]/10 bg-[#393E46] px-4 py-2.5 shadow-lg shadow-black/20 transition-all duration-300 hover:border-[#DFD0B8]/25 hover:bg-[#31363F]"
              >
                <div className="hidden flex-col items-end sm:flex">
                  <span className="text-sm font-bold tracking-wide text-[#DFD0B8]">
                    {usernameLoading ? "..." : displayName}
                  </span>

                  {address && (
                    <span className="text-xs text-[#948979]">
                      {hasUsername ? shortenAddress(address) : "Connected"}
                    </span>
                  )}
                </div>

                <div className="flex flex-col items-end gap-1.5">
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-[#DFD0B8]/20 bg-[#222831] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-[#DFD0B8]">
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-emerald-400" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]" />
                    </span>
                    Verified
                  </span>

                  <span
                    className={`text-[10px] font-medium ${
                      isCorrectNetwork
                        ? "text-[#948979]"
                        : "text-rose-400"
                    }`}
                  >
                    {isCorrectNetwork
                      ? "Coston2"
                      : `Wrong network (${chainId ?? "unknown"})`}
                  </span>
                </div>

                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={`h-3.5 w-3.5 text-[#948979] transition-transform duration-200 ${
                    profileOpen ? "rotate-180" : ""
                  }`}
                  aria-hidden
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>

              {profileOpen && (
                <div
                  role="menu"
                  className="absolute right-0 top-full z-50 mt-2 w-64 origin-top-right rounded-2xl border border-[#DFD0B8]/10 bg-[#393E46] p-4 shadow-2xl shadow-black/30"
                >
                  <div className="mb-4 border-b border-[#DFD0B8]/10 pb-3">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-[#948979]">
                      Wallet address
                    </p>

                    <p
                      className="break-all font-mono text-xs leading-relaxed text-[#DFD0B8]"
                      title={address}
                    >
                      {address}
                    </p>
                  </div>

                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setProfileOpen(false);
                      disconnect();
                    }}
                    className="w-full rounded-xl border border-[#DFD0B8]/10 bg-[#222831] px-3 py-2 text-sm font-semibold text-[#948979] transition-all duration-200 hover:border-rose-400/30 hover:bg-rose-500/10 hover:text-rose-300"
                  >
                    Disconnect
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button
              onClick={connect}
              disabled={isConnecting}
              className="rounded-2xl bg-[#DFD0B8] px-6 py-2.5 text-sm font-bold text-[#222831] shadow-lg shadow-[#DFD0B8]/10 transition-all duration-300 hover:-translate-y-0.5 hover:bg-[#DFD0B8]/90 hover:shadow-[#DFD0B8]/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isConnecting ? "Connecting..." : "Connect Wallet"}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div
          className={`mx-auto mt-3 max-w-7xl rounded-xl border px-4 py-2 text-sm leading-relaxed ring-1 ${
            error === COSTON2_ADD_PROMPT
              ? "border-amber-500/25 bg-amber-500/10 text-amber-200 ring-amber-500/10"
              : "border-rose-500/20 bg-rose-500/10 text-rose-300 ring-rose-500/10"
          }`}
          style={{ whiteSpace: error === COSTON2_ADD_PROMPT ? "pre-line" : undefined }}
        >
          {error}
        </div>
      )}
    </header>
  );
}

export default function Web3Header() {
  return (
    <Suspense fallback={null}>
      <Web3HeaderContent />
    </Suspense>
  );
}