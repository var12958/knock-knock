"use client";

import Link from "next/link";
import Image from "next/image";
import { motion } from "framer-motion";
import { useWeb3 } from "@/context/Web3Context";

export default function LandingPage() {
  const { address } = useWeb3();
  const launchHref = address ? "/send" : "/onboard";

  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-[#222831] px-4 text-[#DFD0B8]">
      {/* Soft ambient glows */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(50rem 50rem at 50% -20%, rgba(223, 208, 184, 0.10), transparent 55%), radial-gradient(45rem 45rem at 80% 120%, rgba(148, 137, 121, 0.08), transparent 55%)",
        }}
      />

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
        className="relative z-10 flex max-w-3xl flex-col items-center text-center"
      >
        {/* Logo + wordmark */}
        <div className="mb-8 flex flex-col items-center gap-5">
          <div className="relative h-28 w-28 overflow-hidden rounded-3xl ring-1 ring-[#DFD0B8]/20 shadow-[0_0_60px_rgba(223,208,184,0.18)]">
            <Image
              src="/logo.png"
              alt="KnockKnock"
              fill
              className="object-cover"
              priority
            />
          </div>
          <div className="flex flex-col items-center">
            <h1 className="text-5xl font-extrabold tracking-tight text-[#DFD0B8] sm:text-6xl">
              KnockKnock
            </h1>
            <span className="mt-2 text-xs font-semibold uppercase tracking-[0.35em] text-[#948979]">
              Web3 Messaging
            </span>
          </div>
        </div>

        {/* Premium tagline */}
        <p className="mb-10 max-w-lg text-2xl font-light leading-snug tracking-tight sm:text-3xl">
          <span className="text-shimmer font-medium">
            Privacy-first Web3 messaging
          </span>
          <br />
          <span className="text-[#948979]">
            knocking on the door of the decentralized web.
          </span>
        </p>

        {/* CTA */}
        <Link
          href={launchHref}
          className="group relative inline-flex items-center gap-3 overflow-hidden rounded-2xl bg-[#DFD0B8] px-10 py-4 text-base font-bold text-[#222831] shadow-[0_0_40px_rgba(223,208,184,0.25)] transition-all duration-300 hover:-translate-y-1 hover:bg-[#DFD0B8]/90 hover:shadow-[0_0_60px_rgba(223,208,184,0.35)]"
        >
          <span className="relative z-10">Launch App</span>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="relative z-10 h-5 w-5 transition-transform duration-300 group-hover:translate-x-1"
          >
            <path d="M5 12h14" />
            <path d="M12 5l7 7-7 7" />
          </svg>
        </Link>

        {/* Trust pills */}
        <div className="mt-12 flex flex-wrap items-center justify-center gap-3 text-xs font-medium text-[#948979]">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[#DFD0B8]/10 bg-[#222831]/60 px-3 py-1.5 backdrop-blur-sm">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            End-to-end encrypted
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[#DFD0B8]/10 bg-[#222831]/60 px-3 py-1.5 backdrop-blur-sm">
            <span className="h-1.5 w-1.5 rounded-full bg-[#DFD0B8]" />
            On-chain identity
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[#DFD0B8]/10 bg-[#222831]/60 px-3 py-1.5 backdrop-blur-sm">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
            Human verified
          </span>
        </div>
      </motion.div>

      {/* Bottom hairline */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-[#DFD0B8]/15 to-transparent"
      />
    </main>
  );
}
